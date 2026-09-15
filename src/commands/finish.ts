import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { GROVE_CONFIG_FILE, isWithinRoot, loadRepoConfig } from "../config.js";
import { TargetNotFoundError, TargetUsageError, printResolvedTarget, resolveCommandTarget, type GroveTarget } from "../target.js";
import { configuredRepositories, type ConfiguredRepository } from "../revisions.js";
import { withRegistryLock } from "../registry.js";
import { configHash } from "../intent.js";
import { currentApplied } from "../types.js";
import { uprootTarget, OwnerChangedError } from "./uproot.js";

const FETCH_TIMEOUT_MS = 30_000;

export interface FinishBranch {
  name: string;
  unlanded: Array<{ sha: string; subject: string }>;
}

export interface FinishWorktree {
  path: string;
  dirtyFiles: number;
}

export interface FinishRepository {
  name: string;
  originBranch: string;
  originSha: string | null;
  branches: FinishBranch[];
  worktrees: FinishWorktree[];
  stash: number;
}

export interface FinishResult {
  instance: string;
  finished: boolean;
  reason: "unlanded" | "unverifiable" | "owner-changed" | null;
  repos: FinishRepository[];
}

export interface LandedCheck {
  result: FinishResult;
  externalWorktrees: string[];
}

/**
 * How much work the landed check found: unlanded commits, dirty working trees,
 * and stash entries. The UI's WORK column and finish's refusal read the same
 * report, so they can only disagree about how current the remote refs are.
 */
export function countWork(result: FinishResult): number {
  let total = 0;
  for (const repository of result.repos) {
    for (const branch of repository.branches) total += branch.unlanded.length;
    total += repository.worktrees.length;
    total += repository.stash;
  }
  return total;
}

export async function finish(targetRef: string | undefined, options: { instance?: string; owner?: string; json?: boolean; selector?: string; all?: boolean }): Promise<void> {
  try {
    if (options.selector !== undefined || options.all) throw usageError("grove finish accepts one target only; selectors and --all are not supported");
    const resolved = resolveCommandTarget({ target: targetRef, instance: options.instance, cwd: process.cwd() });
    const target = resolved.target;
    if (!target.instance) throw usageError(`${target.projectName} is the project source; grove finish needs a planted instance`);
    if (!options.json) printResolvedTarget(resolved);

    const result = await finishTarget(target, options.owner);
    if (options.json) {
      console.log(JSON.stringify(result));
    } else if (result.finished) {
      console.log(`Finished ${result.instance}.`);
    } else {
      printRefusal(result);
    }
    process.exitCode = result.finished ? 0 : 3;
  } catch (error) {
    const status = exitCode(error);
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = status;
  }
}

/** Verify the landed gate and, only when it clears, use the shared uproot procedure. */
export async function finishTarget(target: GroveTarget, owner?: string): Promise<FinishResult> {
  if (!target.instance) throw usageError(`${target.projectName} is the project source; grove finish needs a planted instance`);
  if (target.instance.pending && target.instance.pending !== "uprooting") {
    throw new Error(`${target.projectName}/${target.instance.name} has pending operation ${target.instance.pending}`);
  }

  const resumed: FinishResult = { instance: `${target.projectName}/${target.instance.name}`, finished: false, reason: null, repos: [] };
  const check = target.instance.pending === "uprooting" ? { result: resumed, externalWorktrees: target.instance.uprootWorktrees ?? [] } : await checkLanded(target);
  if (check.result.reason) return check.result;

  try {
    await uprootTarget(target, { force: true, owner, externalWorktrees: check.externalWorktrees, quiet: true, teardownFailure: "abort" });
    return { ...check.result, finished: true };
  } catch (error) {
    if (error instanceof OwnerChangedError) {
      return { ...check.result, reason: "owner-changed" };
    }
    throw error;
  }
}

/** Claim freshness uses the same repository and clean-tree rules as finish. */
export async function verifyClaimFreshness(target: GroveTarget): Promise<string[]> {
  if (!target.instance) return ["the project source is not a claimable instance"];
  const reasons: string[] = [];
  if (target.instance.pending) reasons.push(`pending operation ${target.instance.pending}`);
  if (target.instance.needsState) reasons.push(`state ${target.instance.needsState} is not applied`);

  const sourceConfig = loadRepoConfig(target.project.source, target.project.configFile ?? GROVE_CONFIG_FILE);
  const applied = currentApplied(target.instance);
  const sourceHash = configHash(sourceConfig);
  if (!applied || applied.configHash !== sourceHash) reasons.push("the applied config hash differs from the source config");
  if (target.instance.stateRef !== "baseline") reasons.push(`the applied state is ${target.instance.stateRef ?? "unknown"}, not baseline`);

  let repositories: ConfiguredRepository[];
  try {
    repositories = configuredRepositories(target.root, sourceConfig, "claim");
  } catch (error) {
    return [...reasons, (error as Error).message];
  }

  const fetches = await Promise.all(repositories.map((repository) => fetchOriginBranch(repository)));
  for (let index = 0; index < repositories.length; index++) {
    const repository = repositories[index];
    const fetched = fetches[index];
    if (fetched.kind !== "ok") {
      reasons.push(`${repository.name}: ${fetched.detail}`);
      continue;
    }
    const branch = await git(repository.path, ["branch", "--show-current"], repository.name, "claim");
    const head = await git(repository.path, ["rev-parse", "HEAD"], repository.name, "claim");
    const origin = await git(repository.path, ["rev-parse", `origin/${repository.branch}`], repository.name, "claim");
    if (branch !== repository.branch) reasons.push(`${repository.name}: checked out ${branch || "detached HEAD"}, not ${repository.branch}`);
    if (head !== origin) reasons.push(`${repository.name}: HEAD ${head.slice(0, 12)} is not origin/${repository.branch} ${origin.slice(0, 12)}`);
    const dirty = await git(repository.path, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], repository.name, "claim");
    if (dirty) reasons.push(`${repository.name}: working tree has ${dirty.split("\n").filter(Boolean).length} changed file(s)`);
  }
  return reasons;
}

/**
 * Decide whether an instance holds work, per G1. `fetch: false` compares against
 * the remote-tracking refs already on disk instead of fetching, which is what the
 * UI's WORK column uses: the same rules, at whatever freshness the last fetch left.
 */
export async function checkLanded(target: GroveTarget, options: { fetch?: boolean } = {}): Promise<LandedCheck> {
  const withFetch = options.fetch ?? true;
  const instance = target.instance!;
  const instanceName = `${target.projectName}/${instance.name}`;
  const config = loadRepoConfig(target.project.source, target.project.configFile ?? GROVE_CONFIG_FILE);
  const repositories = configuredRepositories(target.root, config, "finish");
  const repos: FinishRepository[] = repositories.map((repository) => ({
    name: repository.name,
    originBranch: repository.branch,
    originSha: null,
    branches: [],
    worktrees: [],
    stash: 0,
  }));

  const fetches = await Promise.all(repositories.map((repository) => fetchOriginBranch(repository, withFetch)));
  const externalWorktrees: string[] = [];
  let unverifiable = false;
  for (let index = 0; index < repositories.length; index++) {
    const repository = repositories[index];
    const report = repos[index];
    const fetched = fetches[index];
    if (fetched.kind !== "ok") {
      unverifiable = true;
    } else {
      report.originSha = await git(repository.path, ["rev-parse", `origin/${repository.branch}`], repository.name, "finish");
      const branchNames = (await git(repository.path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], repository.name, "finish"))
        .split("\n").filter(Boolean);
      for (const branch of branchNames) {
        const unlanded = await cherry(repository, `origin/${repository.branch}`, branch);
        if (unlanded.length) report.branches.push({ name: branch, unlanded });
      }
    }

    const worktrees = await listWorktrees(repository);
    for (const worktree of worktrees) {
      if (!isWithinRoot(path.resolve(instance.path), path.resolve(worktree.path))) externalWorktrees.push(worktree.path);
      if (!fs.existsSync(worktree.path)) continue;
      if (fetched.kind === "ok" && worktree.detached) {
        const unlanded = await cherry(repository, `origin/${repository.branch}`, "HEAD", worktree.path);
        if (unlanded.length) report.branches.push({ name: `HEAD (${worktree.path})`, unlanded });
      }
      const dirty = await git(worktree.path, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], repository.name, "finish");
      const dirtyFiles = dirty ? dirty.split("\n").filter(Boolean).length : 0;
      if (dirtyFiles) report.worktrees.push({ path: worktree.path, dirtyFiles });
    }
    report.stash = (await git(repository.path, ["stash", "list"], repository.name, "finish")).split("\n").filter(Boolean).length;
  }

  const hasUnlanded = repos.some((report) => report.branches.some((branch) => branch.unlanded.length) || report.worktrees.some((worktree) => worktree.dirtyFiles) || report.stash > 0);
  const result: FinishResult = {
    instance: instanceName,
    finished: false,
    reason: unverifiable ? "unverifiable" : hasUnlanded ? "unlanded" : null,
    repos,
  };
  return { result, externalWorktrees: [...new Set(externalWorktrees)] };
}

async function cherry(repository: ConfiguredRepository, upstream: string, ref: string, cwd = repository.path): Promise<Array<{ sha: string; subject: string }>> {
  const lines = (await git(cwd, ["cherry", upstream, ref], repository.name, "finish")).split("\n").filter((line) => line.startsWith("+ "));
  return Promise.all(lines.map(async (line) => {
    const sha = line.slice(2);
    return { sha: sha.slice(0, 12), subject: await git(cwd, ["log", "-1", "--format=%s", sha], repository.name, "finish") };
  }));
}

interface WorktreeEntry { path: string; detached: boolean }

async function listWorktrees(repository: ConfiguredRepository): Promise<WorktreeEntry[]> {
  const output = await git(repository.path, ["worktree", "list", "--porcelain"], repository.name, "finish");
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), detached: false };
    } else if (line === "detached" && current) {
      current.detached = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

type FetchResult = { kind: "ok" } | { kind: "unverifiable"; detail: string };

async function fetchOriginBranch(repository: ConfiguredRepository, withFetch = true): Promise<FetchResult> {
  try {
    await git(repository.path, ["remote", "get-url", "origin"], repository.name, "finish");
  } catch {
    return { kind: "unverifiable", detail: "has no origin remote" };
  }
  if (!withFetch) {
    try {
      await git(repository.path, ["rev-parse", "--verify", `origin/${repository.branch}`], repository.name, "finish");
    } catch {
      return { kind: "unverifiable", detail: `no local ref for origin/${repository.branch}` };
    }
    return { kind: "ok" };
  }
  const result = await runFetch(repository.path, repository.branch);
  if (result.kind === "timeout") return { kind: "unverifiable", detail: `fetch of origin/${repository.branch} exceeded 30 seconds` };
  if (result.status !== 0) {
    if (result.stderr.includes("couldn't find remote ref") || result.stderr.includes("not our ref")) {
      return { kind: "unverifiable", detail: `origin lacks configured branch ${repository.branch}` };
    }
    throw new Error(`cannot finish ${repository.name}: git fetch origin ${repository.branch} exited with status ${result.status}: ${result.stderr || "no diagnostic"}`);
  }
  try {
    await git(repository.path, ["rev-parse", "--verify", `origin/${repository.branch}`], repository.name, "finish");
  } catch {
    return { kind: "unverifiable", detail: `origin lacks configured branch ${repository.branch}` };
  }
  return { kind: "ok" };
}

function runFetch(cwd: string, branch: string): Promise<{ kind: "timeout" } | { kind: "exit"; status: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["fetch", "--prune", "origin", branch], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, FETCH_TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(timedOut ? { kind: "timeout" } : { kind: "exit", status: code ?? 1, stderr: stderr.trim() }); });
  });
}

/**
 * Asynchronous so a caller that runs the landed check for a whole fleet — the UI's WORK column —
 * keeps its event loop free: a synchronous git call here held every keypress for as long as the
 * check took, up to seconds per instance.
 */
function git(cwd: string, args: string[], name: string, operation: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`cannot ${operation} ${name}: ${stderr.trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

function printRefusal(result: FinishResult): void {
  console.error(`Refused to finish ${result.instance}: ${result.reason}.`);
  for (const repository of result.repos) {
    console.error(`  ${repository.name}: origin/${repository.originBranch} ${repository.originSha ?? "unavailable"}`);
    for (const branch of repository.branches) {
      console.error(`    ${branch.name}:`);
      for (const commit of branch.unlanded.slice(0, 5)) console.error(`      ${commit.sha} ${commit.subject}`);
      if (branch.unlanded.length > 5) console.error(`      +${branch.unlanded.length - 5} more`);
    }
    for (const worktree of repository.worktrees) console.error(`    ${worktree.path}: ${worktree.dirtyFiles} changed file(s)`);
    if (repository.stash) console.error(`    stash: ${repository.stash} entr${repository.stash === 1 ? "y" : "ies"}`);
  }
  console.error(`Land the work (push and merge the named branches), or discard it deliberately with grove uproot ${result.instance} --force.`);
}

class UsageError extends Error {}
function usageError(message: string): UsageError { return new UsageError(message); }
function exitCode(error: unknown): number {
  if (error instanceof UsageError || error instanceof TargetUsageError) return 2;
  if (error instanceof TargetNotFoundError) return 4;
  return 1;
}

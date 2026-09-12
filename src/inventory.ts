import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { loadRepoConfig, type GroveRepoConfig } from "./config.js";
import { configHash } from "./intent.js";
import { computePorts, checkPort, maxSlot } from "./ports.js";
import { loadRegistry } from "./registry.js";
import { targetSlot, type GroveTarget } from "./target.js";
import { tmuxSessionName } from "./tmux.js";
import type { GroveApplied, GroveInstanceSpec } from "./types.js";

export interface InventoryPort {
  name: string;
  port: number;
  live: boolean;
}

export interface InventoryRepo {
  name: string;
  path: string;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean | null;
}

export interface InventoryTarget {
  name: string;
  slot: number;
  path: string;
  exists: boolean;
  created: string | null;
  needsState: string | null;
  pending: "planting" | null;
  spec: GroveInstanceSpec | null;
  applied: GroveApplied | null;
  configStale: boolean;
  tmuxSession: string;
  lifecycle: string[];
  ports: InventoryPort[];
  repos: InventoryRepo[];
}

export interface InventoryProject {
  name: string;
  source: string;
  configFile: string;
  sourceExists: boolean;
  nameIsSlot: boolean;
  /** null means declared ports place no upper bound on slots. */
  maxSlot: number | null;
  source_target: InventoryTarget;
  instances: InventoryTarget[];
}

export interface GroveInventory {
  version: 1;
  projects: InventoryProject[];
}

export async function gatherInventory(projectName?: string): Promise<GroveInventory> {
  const registry = loadRegistry();
  const selected = projectName ? [[projectName, registry.projects[projectName]] as const] : Object.entries(registry.projects);
  const projects = await Promise.all(selected.map(async ([name, project]) => {
    if (!project) throw new Error(`project "${name}" not registered.`);
    const sourceExists = fs.existsSync(project.source);
    const sourceConfig = sourceExists ? loadRepoConfig(project.source, project.configFile) : null;
    const lifecycle = Object.keys(sourceConfig?.lifecycle ?? {});
    const sourceConfigHash = sourceExists ? configHash(sourceConfig) : null;
    const projectMaxSlot = maxSlot(project.ports);
    const sourceTarget: GroveTarget = { project, projectName: name, root: path.resolve(project.source) };
    const instances = [...project.instances]
      .sort((a, b) => a.slot - b.slot)
      .map((instance) => ({ project, projectName: name, root: path.resolve(instance.path), instance }));
    const [source_target, ...instanceTargets] = await Promise.all([
      gatherTarget(sourceTarget, sourceConfig, lifecycle, sourceConfigHash),
      ...instances.map((target) => gatherTarget(target, undefined, lifecycle, sourceConfigHash)),
    ]);
    return {
      name,
      source: project.source,
      configFile: project.configFile ?? ".grove/config.json",
      sourceExists,
      nameIsSlot: sourceConfig?.nameIsSlot ?? false,
      maxSlot: Number.isFinite(projectMaxSlot) ? projectMaxSlot : null,
      source_target,
      instances: instanceTargets,
    };
  }));
  return { version: 1, projects: projects.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
}

async function gatherTarget(
  target: GroveTarget,
  config: GroveRepoConfig | null | undefined,
  lifecycle: string[],
  sourceConfigHash: string | null,
): Promise<InventoryTarget> {
  const exists = fs.existsSync(target.root);
  const targetConfig = config === undefined && exists
    ? loadRepoConfig(target.root, target.project.configFile)
    : config;
  const ports = computePorts(target.project.ports, targetSlot(target));
  const portChecks = Promise.all(Object.entries(ports).map(async ([name, port]) => ({
    name,
    port,
    live: await checkPort(port),
  })));
  const repos = repoEntries(target.root, targetConfig);
  const repoStates = await Promise.all(repos.map(async (repo) => ({ ...repo, ...(await gitState(repo.path)) })));
  const instance = target.instance;
  const applied = instance?.applied ?? null;
  return {
    name: target.instance?.name ?? target.projectName,
    slot: targetSlot(target),
    path: target.root,
    exists,
    created: target.instance?.created ?? null,
    needsState: target.instance?.needsState ?? null,
    pending: target.instance?.pending ?? null,
    spec: instance?.spec ?? null,
    applied,
    configStale: applied !== null && sourceConfigHash !== null && applied.configHash !== sourceConfigHash,
    tmuxSession: tmuxSessionName(target),
    lifecycle,
    ports: await portChecks,
    repos: repoStates,
  };
}

function repoEntries(root: string, config: GroveRepoConfig | null | undefined): Array<Pick<InventoryRepo, "name" | "path">> {
  if (config?.repos) {
    return Object.keys(config.repos).map((name) => ({ name, path: path.join(root, name) }));
  }
  return fs.existsSync(path.join(root, ".git")) ? [{ name: ".", path: root }] : [];
}

let gitJobs = 0;
const queuedGitJobs: Array<() => void> = [];

async function gitState(repoPath: string): Promise<Omit<InventoryRepo, "name" | "path">> {
  return withGitSlot(async () => {
    try {
      const output = await runGitStatus(repoPath);
      return parseGitStatus(output);
    } catch {
      return { branch: null, upstream: null, ahead: null, behind: null, dirty: null };
    }
  });
}

function withGitSlot<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      gitJobs++;
      operation().then(resolve, reject).finally(() => {
        gitJobs--;
        queuedGitJobs.shift()?.();
      });
    };
    if (gitJobs < 8) run(); else queuedGitJobs.push(run);
  });
}

/**
 * `--no-optional-locks` is load-bearing, not tidiness. A plain `git status`
 * refreshes the index and takes `.git/index.lock` to write it back; gathering
 * runs it across every repo of every slot, so quitting the TUI or closing the
 * popup mid-gather kills a status that is holding that lock and leaves an empty
 * stale one behind. Nothing in git ever reaps it, and every later git command in
 * that repo then fails with "another git process seems to be running".
 */
function runGitStatus(repoPath: string): Promise<string> {
  return runGit(["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=no"], repoPath);
}

function runGit(args: string[], repoPath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoPath, signal }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim())); else resolve(stdout);
    });
  });
}

/**
 * Fetch every named repo, bounded by the same concurrency limit as the status
 * pass. Only the TUI's refresh key calls this — gathering never touches the
 * network. Returns one entry per repo that failed; the rest simply succeeded.
 *
 * Aborting the signal kills the fetches already running and skips the ones still
 * queued, so a hung remote cannot hold the caller.
 */
export async function fetchRepos(repoPaths: string[], signal?: AbortSignal): Promise<Array<{ path: string; error: string }>> {
  const outcomes = await Promise.all(repoPaths.map((repoPath) => withGitSlot(async () => {
    if (signal?.aborted) return { path: repoPath, error: "skipped — interrupted" };
    try {
      await runGit(["fetch", "--quiet"], repoPath, signal);
      return null;
    } catch (error) {
      return { path: repoPath, error: (error as Error).message };
    }
  })));
  return outcomes.filter((outcome): outcome is { path: string; error: string } => outcome !== null);
}

function parseGitStatus(output: string): Omit<InventoryRepo, "name" | "path"> {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let dirty = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line && !line.startsWith("#")) {
      dirty = true;
    }
  }
  return { branch, upstream, ahead, behind, dirty };
}

export function formatGitState(repo: InventoryRepo): string {
  const branch = repo.branch ?? "—";
  const ahead = repo.ahead === null ? "—" : String(repo.ahead);
  const behind = repo.behind === null ? "—" : String(repo.behind);
  const dirty = repo.dirty === null ? "?" : repo.dirty ? " ✱" : "";
  return `${repo.name} ${branch} ↑${ahead} ↓${behind}${dirty}`;
}

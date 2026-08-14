import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { PortDef } from "./types.js";
import { CopyFromSourceSpec, InstallSpec, RepoSpec, GROVE_CONFIG_FILE } from "./config.js";

// ---------------------------------------------------------------------------
// Glob matching (minimal, no dependencies)
// ---------------------------------------------------------------------------

function expandBraces(pattern: string): string[] {
  const m = pattern.match(/\{([^}]+)\}/);
  if (!m) return [pattern];
  return m[1].split(",").flatMap((alt) => expandBraces(pattern.replace(m[0], alt)));
}

function segmentMatch(segment: string, pattern: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(segment);
}

function globPartsMatch(
  parts: string[],
  pi: number,
  pat: string[],
  gi: number,
): boolean {
  if (gi === pat.length) return pi === parts.length;
  if (pat[gi] === "**") {
    for (let i = pi; i <= parts.length; i++) {
      if (globPartsMatch(parts, i, pat, gi + 1)) return true;
    }
    return false;
  }
  if (pi >= parts.length) return false;
  if (!segmentMatch(parts[pi], pat[gi])) return false;
  return globPartsMatch(parts, pi + 1, pat, gi + 1);
}

/** Test a relative file path against a glob pattern (supports *, **, {a,b}). */
export function matchGlob(filePath: string, pattern: string): boolean {
  return expandBraces(pattern).some((p) =>
    globPartsMatch(filePath.split("/"), 0, p.split("/"), 0),
  );
}

/** Recursively list all files under `dir`, returning paths relative to `dir`. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Recursively copy `src` to `dest`. Dereferences valid symlinks (matching prior
 * `cp -r` behavior) but skips broken symlinks with a warning instead of failing.
 */
function copyRecursive(src: string, dest: string): void {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(src);
  } catch {
    console.log(`  Warning: cannot stat ${src}, skipping`);
    return;
  }

  if (lstat.isSymbolicLink()) {
    if (!fs.existsSync(src)) {
      console.log(`  Warning: skipping broken symlink ${src}`);
      return;
    }
    const realStat = fs.statSync(src);
    if (realStat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        copyRecursive(path.join(src, entry), path.join(dest, entry));
      }
    } else if (realStat.isFile()) {
      fs.copyFileSync(src, dest);
    }
    return;
  }

  if (lstat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }

  if (lstat.isFile()) {
    fs.copyFileSync(src, dest);
  }
}

// ---------------------------------------------------------------------------
// Clone repos
// ---------------------------------------------------------------------------

/** Where a plant takes its code from: configured branches, or the source checkout's own commits. */
export type CodeSource = "configured" | "@source";

export interface SourceRepoCommit {
  repo: string;
  /** The source checkout of this repo, which is also the clone's origin. */
  path: string;
  sha: string;
  /** Branch holding that commit, or null when the source checkout is detached. */
  branch: string | null;
  remoteUrl: string | null;
}

function git(repoPath: string, args: string): string {
  return execSync(`git -C "${repoPath}" ${args}`, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOrNull(repoPath: string, args: string): string | null {
  try {
    return git(repoPath, args) || null;
  } catch {
    return null;
  }
}

/** Run a git command for its effect alone; false when it fails. */
function gitTry(repoPath: string, args: string): boolean {
  try {
    git(repoPath, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve every configured repo's exact commit in the source checkout, reporting
 * every problem at once. Repos in a composite workspace move independently, so
 * a half-source/half-configured instance is worse than refusing until the source
 * is committed and clean.
 */
export function resolveSourceCommits(
  source: string,
  repos: Record<string, RepoSpec>,
): Record<string, SourceRepoCommit> {
  const resolved: Record<string, SourceRepoCommit> = {};
  const problems: string[] = [];

  for (const repoName of Object.keys(repos)) {
    const repoPath = path.join(source, repoName);

    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      problems.push(`${repoName}: not a git repo in the source (${repoPath})`);
      continue;
    }

    let status: string;
    try {
      status = git(repoPath, "status --porcelain");
    } catch (error) {
      problems.push(`${repoName}: cannot read git status — ${(error as Error).message.trim()}`);
      continue;
    }
    if (status) {
      const count = status.split("\n").length;
      problems.push(
        `${repoName}: ${count} uncommitted change(s) — see \`git -C "${repoPath}" status --short\``,
      );
      continue;
    }

    let sha: string;
    try {
      sha = git(repoPath, "rev-parse HEAD");
    } catch (error) {
      problems.push(`${repoName}: cannot resolve HEAD — ${(error as Error).message.trim()}`);
      continue;
    }

    resolved[repoName] = {
      repo: repoName,
      path: repoPath,
      sha,
      branch: gitOrNull(repoPath, "symbolic-ref --quiet --short HEAD"),
      remoteUrl: gitOrNull(repoPath, "remote get-url origin"),
    };
  }

  if (problems.length) {
    throw new Error(
      "--code-from @source needs every configured repo committed and resolvable:\n" +
        problems.map((p) => `  ${p}`).join("\n") +
        "\nCommit or stash the changes, or plant with --code-from configured.",
    );
  }
  return resolved;
}

/**
 * Clone each repo at the source checkout's own commit. The clone's remote is the
 * local source path, not origin, because a local commit may never have been
 * pushed; origin is pointed back at the real remote once the commit is in place.
 */
export function cloneReposFromSource(
  target: string,
  repos: Record<string, RepoSpec>,
  commits: Record<string, SourceRepoCommit>,
): void {
  fs.mkdirSync(target, { recursive: true });

  for (const [repoName, spec] of Object.entries(repos)) {
    const commit = commits[repoName];
    const destRepo = path.join(target, repoName);
    const short = commit.sha.slice(0, 8);

    console.log(`  Cloning ${repoName} → ${commit.branch ?? "detached"} @ ${short} ...`);
    // --no-hardlinks: the instance's objects must survive a gc in the source.
    execSync(
      `git clone --quiet --no-checkout --no-hardlinks "${commit.path}" "${destRepo}"`,
      { stdio: "inherit" },
    );

    if (commit.branch) {
      execSync(`git -C "${destRepo}" checkout --quiet -B "${commit.branch}" ${commit.sha}`, {
        stdio: "inherit",
      });
    } else {
      execSync(`git -C "${destRepo}" checkout --quiet --detach ${commit.sha}`, {
        stdio: "inherit",
      });
    }

    if (commit.remoteUrl) {
      execSync(`git -C "${destRepo}" remote set-url origin "${commit.remoteUrl}"`, {
        stdio: "inherit",
      });
      // The clone's remote-tracking refs mirror the source checkout's branches,
      // not the real remote's. One pruning fetch makes them true; only then can
      // an upstream be trusted, and a branch the remote lacks keeps none.
      if (!gitTry(destRepo, "fetch --quiet --prune origin")) {
        console.log(
          `    Note: could not fetch ${repoName} from origin — its remote-tracking branches still mirror the source`,
        );
      } else if (commit.branch) {
        // The clone inherited an upstream describing the source's branch. Keep it
        // only when the real remote carries that branch; a local-only branch has
        // no upstream, exactly as in the source.
        if (gitOrNull(destRepo, `rev-parse --verify --quiet origin/${commit.branch}`)) {
          gitTry(destRepo, `branch --set-upstream-to=origin/${commit.branch}`);
        } else {
          gitTry(destRepo, "branch --unset-upstream");
        }
      }
    } else {
      console.log(`    Note: no origin in the source; this clone's origin is ${commit.path}`);
    }

    if (spec.recurseSubmodules) {
      execSync(`git -C "${destRepo}" submodule update --init --recursive --quiet`, {
        stdio: "inherit",
      });
    }
  }
}

/** What code a planted checkout actually holds, read back from the clones themselves. */
export function describeClonedRepos(
  target: string,
  repos: Record<string, RepoSpec>,
): Record<string, { branch: string | null; sha: string }> {
  const described: Record<string, { branch: string | null; sha: string }> = {};
  for (const repoName of Object.keys(repos)) {
    const repoPath = path.join(target, repoName);
    const sha = gitOrNull(repoPath, "rev-parse HEAD");
    if (!sha) continue;
    described[repoName] = {
      branch: gitOrNull(repoPath, "symbolic-ref --quiet --short HEAD"),
      sha,
    };
  }
  return described;
}

export function cloneRepos(
  source: string,
  target: string,
  repos: Record<string, RepoSpec>,
): void {
  fs.mkdirSync(target, { recursive: true });

  for (const [repoName, spec] of Object.entries(repos)) {
    const srcRepo = path.join(source, repoName);
    const destRepo = path.join(target, repoName);
    const branch = spec.branch ?? "main";

    if (!fs.existsSync(path.join(srcRepo, ".git"))) {
      console.log(`  Skipping ${repoName} (not a git repo in source)`);
      continue;
    }

    let remoteUrl: string;
    try {
      remoteUrl = execSync(`git -C "${srcRepo}" remote get-url origin`, {
        encoding: "utf-8",
      }).trim();
    } catch {
      console.log(`  Skipping ${repoName} (no origin remote)`);
      continue;
    }

    console.log(`  Cloning ${repoName} → ${branch} ...`);
    const submoduleFlag = spec.recurseSubmodules ? " --recurse-submodules" : "";
    execSync(
      `git clone -b "${branch}"${submoduleFlag} "${remoteUrl}" "${destRepo}" --quiet`,
      { stdio: "inherit" },
    );
  }
}

// ---------------------------------------------------------------------------
// Copy files from source
// ---------------------------------------------------------------------------

function isSelectedConfig(target: string, filePath: string, configFile: string): boolean {
  return path.normalize(path.relative(target, filePath)) === path.normalize(configFile);
}

export function copyFromSource(
  source: string,
  target: string,
  specs: CopyFromSourceSpec[],
  portDefs: Record<string, PortDef>,
  slot: number,
  configFile = GROVE_CONFIG_FILE,
): void {
  for (const spec of specs) {
    const src = path.join(source, spec.from);
    const dest = path.join(target, spec.to ?? spec.from);

    if (!fs.existsSync(src)) {
      console.log(`  Skipping copy: ${spec.from} (not found in source)`);
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      copyRecursive(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
    console.log(`  Copied ${spec.from}`);

    if (spec.patchPorts) {
      if (stat.isDirectory()) {
        const files = walkDir(dest);
        for (const file of files) {
          if (!isSelectedConfig(target, file, configFile)) {
            patchPortsInFile(file, portDefs, slot);
          }
        }
      } else if (!isSelectedConfig(target, dest, configFile)) {
        patchPortsInFile(dest, portDefs, slot);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Port patching
// ---------------------------------------------------------------------------

/**
 * Build port replacement pairs from port definitions.
 * For each port, replaces the base number with the computed number wherever
 * the base appears as a standalone number (not part of a larger number).
 */
function buildPortReplacements(
  portDefs: Record<string, PortDef>,
  slot: number,
): Array<{ base: number; computed: number; regex: RegExp }> {
  const replacements: Array<{ base: number; computed: number; regex: RegExp }> = [];
  const seen = new Set<number>();

  for (const def of Object.values(portDefs)) {
    if (seen.has(def.base)) continue;
    seen.add(def.base);
    const computed = def.base + slot * def.offset;
    if (computed === def.base) continue; // slot 0 — nothing to replace
    replacements.push({
      base: def.base,
      computed,
      regex: new RegExp(`(?<!\\d)${def.base}(?!\\d)`, "g"),
    });
  }
  return replacements;
}

function patchPortsInFile(
  filePath: string,
  portDefs: Record<string, PortDef>,
  slot: number,
): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  const replacements = buildPortReplacements(portDefs, slot);
  let patched = content;
  for (const r of replacements) {
    patched = patched.replace(r.regex, String(r.computed));
  }

  if (patched !== content) {
    fs.writeFileSync(filePath, patched, "utf-8");
    return true;
  }
  return false;
}

/**
 * Patch port references in all files matching the given glob patterns.
 * Automatically skips grove's own config.json to avoid rewriting base definitions.
 */
export function patchPorts(
  target: string,
  globs: string[],
  portDefs: Record<string, PortDef>,
  slot: number,
  configFile = GROVE_CONFIG_FILE,
): void {
  const allFiles = walkDir(target);
  let patchedCount = 0;

  for (const absPath of allFiles) {
    const rel = path.relative(target, absPath);

    // Never patch grove's own config — it stores base port definitions
    if (isSelectedConfig(target, absPath, configFile)) continue;

    // Never patch committed env templates — by convention they hold base/
    // placeholder values, so patching them just creates a spurious diff in
    // every instance (the real .env, copied + patched, is what runs).
    const base = path.basename(rel);
    if (base === ".env.example" || base === ".env.sample" || base === ".env.template") continue;

    const matches = globs.some((g) => matchGlob(rel, g));
    if (!matches) continue;

    if (patchPortsInFile(absPath, portDefs, slot)) {
      patchedCount++;
    }
  }

  console.log(`  Patched ports in ${patchedCount} file(s)`);
}

// ---------------------------------------------------------------------------
// Install dependencies
// ---------------------------------------------------------------------------

interface RunCommandsOptions {
  /** Phase name used in log lines and errors. */
  label: string;
  /** When true a failing command throws instead of warning and continuing. */
  fatal: boolean;
}

function runCommands(target: string, specs: InstallSpec[], opts: RunCommandsOptions): void {
  for (const spec of specs) {
    const dir = path.join(target, spec.dir);
    if (!fs.existsSync(dir)) {
      // A missing directory is survivable for installs but not for secrets:
      // silently skipping leaves the instance without env files it needs.
      if (opts.fatal) {
        throw new Error(`${opts.label} directory not found in target: ${spec.dir}`);
      }
      console.log(`  Skipping ${opts.label} in ${spec.dir} (directory not found)`);
      continue;
    }

    console.log(`  Running ${opts.label} in ${spec.dir}...`);
    for (const cmd of spec.cmds) {
      try {
        execSync(cmd, { stdio: "inherit", cwd: dir });
      } catch {
        if (opts.fatal) {
          throw new Error(`${opts.label} command failed in ${spec.dir}: ${cmd}`);
        }
        console.error(`  Warning: command failed in ${spec.dir}: ${cmd}`);
      }
    }
    console.log(`  ${spec.dir} ready`);
  }
}

export function runInstalls(target: string, specs: InstallSpec[]): void {
  runCommands(target, specs, { label: "install", fatal: false });
}

/**
 * Materialize secrets into the target. Unlike installs these are fatal: a
 * missing secret surfaces later as an unexplained runtime failure rather than
 * as the plant error it actually is.
 */
export function runSecrets(target: string, specs: InstallSpec[]): void {
  runCommands(target, specs, { label: "secrets", fatal: true });
}

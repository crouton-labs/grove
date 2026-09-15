import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type { GroveRepoConfig } from "./config.js";
import type { GroveApplied } from "./types.js";

export interface ConfiguredRepository {
  name: string;
  path: string;
  branch: string;
}

interface WorktreeEntry {
  path: string;
  prunable: boolean;
}

/** Resolve every configured repository without inferring a branch from a checkout. */
export function configuredRepositories(root: string, config: GroveRepoConfig | null, operation: string): ConfiguredRepository[] {
  if (!config?.repos || Object.keys(config.repos).length === 0) {
    throw new Error(`cannot ${operation}: ${root}'s config declares no repositories with configured branches`);
  }
  return Object.entries(config.repos).map(([name, spec]) => {
    const repoPath = path.join(root, name);
    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      throw new Error(`cannot ${operation}: configured repo is not a git checkout: ${repoPath}`);
    }
    const gitRoot = runGit(repoPath, ["rev-parse", "--show-toplevel"], name, operation);
    if (path.resolve(gitRoot) !== fs.realpathSync(repoPath)) {
      throw new Error(`cannot ${operation}: configured repo is not its git worktree root: ${repoPath}`);
    }
    return { name, path: repoPath, branch: spec.branch ?? "main" };
  });
}

/** Refuse tracked changes, and optionally untracked files, before changing any repository. */
export function assertConfiguredRepositoriesClean(
  repositories: readonly ConfiguredRepository[],
  operation: string,
  includeUntracked = false,
): void {
  const dirty: string[] = [];
  for (const repository of repositories) {
    const status = runGit(
      repository.path,
      ["--no-optional-locks", "status", "--porcelain", `--untracked-files=${includeUntracked ? "all" : "no"}`, "--ignore-submodules=none"],
      repository.name,
      operation,
    );
    if (status) dirty.push(repository.name);
  }
  if (dirty.length) {
    const changes = includeUntracked ? "tracked or untracked changes" : "tracked changes";
    const recovery = includeUntracked ? "; commit or stash them first, or pass --force" : "; commit or stash them first";
    throw new Error(`refusing to ${operation}: ${changes} in ${dirty.join(", ")}${recovery}`);
  }
}

/** Refuse release when a side branch is not recoverable from a remote or an extra worktree is dirty. */
export function assertConfiguredRepositoriesReleaseSafe(repositories: readonly ConfiguredRepository[]): void {
  const work: string[] = [];
  for (const repository of repositories) {
    for (const branch of localBranches(repository)) {
      if (branch === repository.branch) continue;
      const commits = runGit(repository.path, ["rev-list", branch, "--not", "--remotes"], repository.name, "release")
        .split("\n").filter(Boolean);
      if (commits.length) work.push(`${repository.name}: branch ${branch} (${commits.length} commits on no remote)`);
    }
    const ownPath = resolvedPath(repository.path);
    const detached = detachedHeadWork(repository, repository.path);
    if (detached) work.push(detached);
    for (const worktree of listWorktrees(repository)) {
      if (worktree.prunable || !fs.existsSync(worktree.path) || resolvedPath(worktree.path) === ownPath) continue;
      const status = runGit(
        worktree.path,
        ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
        repository.name,
        "release",
      );
      const changedFiles = status ? status.split("\n").filter(Boolean).length : 0;
      if (changedFiles) work.push(`${repository.name}: worktree ${worktree.path} (${changedFiles} changed files)`);
      const detachedWorktree = detachedHeadWork(repository, worktree.path);
      if (detachedWorktree) work.push(detachedWorktree);
    }
  }
  if (work.length) {
    throw new Error(`refusing to release: work that exists only in this instance — ${work.join(", ")}; push or delete it first, or pass --force`);
  }
}

/** Fetch and fast-forward every repository to its configured branch. */
export function fastForwardConfiguredRepositories(repositories: readonly ConfiguredRepository[], operation = "roll out"): void {
  for (const repository of repositories) {
    console.log(`  Fetching ${repository.name}...`);
    runGit(repository.path, ["fetch", "--quiet"], repository.name, operation);
    console.log(`  Fast-forwarding ${repository.name} to ${repository.branch}...`);
    runGit(repository.path, ["checkout", "--quiet", repository.branch], repository.name, operation);
    runGit(repository.path, ["merge", "--ff-only", `origin/${repository.branch}`], repository.name, operation);
  }
}

/** Discard every configured repository's worktree changes before replacing its code. */
export function discardConfiguredRepositoryChanges(repositories: readonly ConfiguredRepository[], operation: string): void {
  for (const repository of repositories) {
    console.log(`  Discarding changes in ${repository.name}...`);
    runGit(repository.path, ["reset", "--hard"], repository.name, operation);
    runGit(repository.path, ["clean", "-fd"], repository.name, operation);
  }
}

/** Remove every worktree and local branch except the configured checkout and branch. */
export function removeReleaseSideBranchesAndWorktrees(repositories: readonly ConfiguredRepository[], force: boolean): void {
  for (const repository of repositories) {
    runGit(repository.path, ["worktree", "prune"], repository.name, "release");
    const ownPath = resolvedPath(repository.path);
    for (const worktree of listWorktrees(repository)) {
      if (resolvedPath(worktree.path) === ownPath) continue;
      console.log(`  Removing worktree ${worktree.path}...`);
      runGit(repository.path, force ? ["worktree", "remove", "--force", worktree.path] : ["worktree", "remove", worktree.path], repository.name, "release");
    }
    for (const branch of localBranches(repository)) {
      if (branch === repository.branch) continue;
      const tip = runGit(repository.path, ["rev-parse", branch], repository.name, "release");
      console.log(`  Deleting branch ${branch} (${tip.slice(0, 12)})...`);
      runGit(repository.path, ["branch", "-D", branch], repository.name, "release");
    }
  }
}

/** Move every configured repository to the commit named by a previous revision. */
export function checkoutPreviousRevision(repositories: readonly ConfiguredRepository[], revision: GroveApplied): void {
  if (!revision.code) {
    throw new Error("cannot roll back: the previous revision has no recorded repository commits");
  }
  for (const repository of repositories) {
    const recorded = revision.code[repository.name];
    if (!recorded) {
      throw new Error(`cannot roll back: the previous revision has no commit for ${repository.name}`);
    }
    if (!recorded.branch) {
      throw new Error(`cannot roll back: the previous revision has no branch for ${repository.name}`);
    }
    console.log(`  Checking out ${repository.name} at ${recorded.commit.slice(0, 12)}...`);
    runGit(repository.path, ["checkout", "--quiet", "-B", recorded.branch, recorded.commit], repository.name, "roll back");
  }
}

/** Describe a checkout that is detached on commits no remote holds, or nothing when it is on a branch or already pushed. */
function detachedHeadWork(repository: ConfiguredRepository, checkoutPath: string): string | undefined {
  if (runGit(checkoutPath, ["branch", "--show-current"], repository.name, "release")) return undefined;
  const commits = runGit(checkoutPath, ["rev-list", "HEAD", "--not", "--remotes"], repository.name, "release")
    .split("\n").filter(Boolean);
  if (!commits.length) return undefined;
  return `${repository.name}: detached HEAD in ${checkoutPath} (${commits.length} commits on no remote)`;
}

/** Resolve symlinks when the path exists; a worktree git still lists after its directory is gone resolves lexically. */
function resolvedPath(target: string): string {
  return fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
}

function localBranches(repository: ConfiguredRepository): string[] {
  return runGit(repository.path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], repository.name, "release")
    .split("\n").filter(Boolean);
}

function listWorktrees(repository: ConfiguredRepository): WorktreeEntry[] {
  const output = runGit(repository.path, ["worktree", "list", "--porcelain"], repository.name, "release");
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), prunable: false };
    } else if (line.startsWith("prunable") && current) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function runGit(repoPath: string, args: string[], name: string, operation: string): string {
  try {
    return execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const detail = failure.stderr?.toString().trim() || failure.message;
    throw new Error(`cannot ${operation} ${name}: ${detail}`);
  }
}

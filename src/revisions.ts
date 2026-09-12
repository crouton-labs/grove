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

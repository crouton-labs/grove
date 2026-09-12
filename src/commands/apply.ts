import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GROVE_CONFIG_FILE, loadRepoConfig } from "../config.js";
import { groveContextEnv } from "../context.js";
import { configHash } from "../intent.js";
import { computePorts } from "../ports.js";
import { saveRegistry, withRegistryLock } from "../registry.js";
import { currentRegisteredTarget, runSequential, selectTargets, type TargetingOptions } from "../selection.js";
import { loadSettings } from "../settings.js";
import { applyExistingCheckoutSetup, describeAppliedCode } from "../setup.js";
import { assertTargetUsable, type GroveTarget, targetSlot } from "../target.js";

interface ApplyOptions extends TargetingOptions {
  force?: boolean;
}

/** Converge an existing instance's Grove-owned configuration without touching code or state. */
export async function apply(targetOrProject: string | undefined, options: ApplyOptions): Promise<void> {
  try {
    const selection = selectTargets(targetOrProject, options, process.cwd());
    process.exitCode = selection.fanOut
      ? await runSequential(selection.targets, (target) => applyTarget(target, options))
      : await applyTarget(selection.targets[0], options);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

export async function applyTarget(target: GroveTarget, options: Pick<ApplyOptions, "force">): Promise<number> {
  if (!target.instance) {
    throw new Error(`${target.projectName} is the project source; grove apply needs a planted instance (for example ${target.projectName}/1)`);
  }
  // Keep uproot from replacing this slot while setup writes the checkout.
  return withRegistryLock(async (registry) => {
    const current = currentRegisteredTarget(registry, target);
    assertTargetUsable(current);
    const targetInstance = current.instance!;
    const configFile = current.project.configFile ?? GROVE_CONFIG_FILE;
    const sourceConfig = loadRepoConfig(current.project.source, configFile);
    assertPortContract(current.project.ports, sourceConfig?.ports);
    const settings = loadSettings();
    const context = {
      projectName: current.projectName,
      source: current.project.source,
      target: current.root,
      slot: targetSlot(current),
      instanceName: targetInstance.name,
      ports: computePorts(sourceConfig?.ports ?? current.project.ports, targetSlot(current)),
    };

    // Build the shared environment and validate every configured repository
    // before any setup phase can rewrite the target. --force permits dirty
    // worktrees, not a missing checkout.
    groveContextEnv(context, process.env, settings);
    assertRepositoriesReadyForApply(current.root, sourceConfig?.repos, options.force === true);

    console.log(`Applying ${current.projectName}/${targetInstance.name} (slot ${targetInstance.slot})`);
    applyExistingCheckoutSetup(
      current.project.source,
      current.root,
      sourceConfig,
      current.project.ports,
      configFile,
      context,
      settings,
    );

    targetInstance.applied = {
      configHash: configHash(sourceConfig),
      at: new Date().toISOString(),
      code: describeAppliedCode(current.root, sourceConfig?.repos),
    };
    await saveRegistry(registry);

    console.log(`Applied: ${current.projectName}/${targetInstance.name}`);
    return 0;
  });
}

function assertPortContract(
  registeredPorts: Record<string, { base: number; offset: number }>,
  sourcePorts: Record<string, { base: number; offset: number }> | undefined,
): void {
  if (!sourcePorts) return;
  const registeredNames = Object.keys(registeredPorts).sort();
  const sourceNames = Object.keys(sourcePorts).sort();
  const matches = registeredNames.length === sourceNames.length && registeredNames.every((name, index) =>
    name === sourceNames[index] &&
    registeredPorts[name].base === sourcePorts[name].base &&
    registeredPorts[name].offset === sourcePorts[name].offset,
  );
  if (!matches) {
    throw new Error("source config ports differ from the registered port contract; run `grove register --update` for this source before applying");
  }
}

function assertRepositoriesReadyForApply(
  root: string,
  repos: Record<string, unknown> | undefined,
  force: boolean,
): void {
  const repoPaths = repos ? Object.keys(repos).map((repo) => path.join(root, repo)) : [root];
  const dirty: string[] = [];
  for (const repoPath of repoPaths) {
    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      throw new Error(`cannot apply: configured repo is not a git checkout: ${repoPath}`);
    }
    try {
      const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (path.resolve(gitRoot) !== fs.realpathSync(repoPath)) {
        throw new Error("configured repo path is not its git worktree root");
      }
    } catch {
      throw new Error(`cannot apply: configured repo is not a git checkout: ${repoPath}`);
    }
    if (force) continue;
    let status: string;
    try {
      status = execFileSync("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no", "--ignore-submodules=none"], {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`cannot read git status in ${repoPath}: ${(error as Error).message}`);
    }
    if (status.trim()) dirty.push(path.relative(root, repoPath) || ".");
  }
  if (dirty.length) {
    throw new Error(`refusing to apply over tracked changes in ${dirty.join(", ")}; commit or stash them, or pass --force`);
  }
}

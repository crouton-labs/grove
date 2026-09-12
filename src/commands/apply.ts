import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { GROVE_CONFIG_FILE, loadRepoConfig } from "../config.js";
import { groveContextEnv } from "../context.js";
import { configHash } from "../intent.js";
import { computePorts } from "../ports.js";
import { saveRegistry, withRegistryLock } from "../registry.js";
import { loadSettings } from "../settings.js";
import { applyExistingCheckoutSetup, describeAppliedCode } from "../setup.js";
import { assertTargetUsable, resolveTargetFromRef, targetSlot } from "../target.js";
import type { GroveApplied } from "../types.js";

interface ApplyOptions {
  force?: boolean;
}

/** Converge an existing instance's Grove-owned configuration without touching code or state. */
export async function apply(targetRef: string, options: ApplyOptions): Promise<void> {
  try {
    const target = resolveTargetFromRef(targetRef);
    if (!target.instance) {
      throw new Error(`${targetRef} is the project source; grove apply needs a planted instance (for example ${target.projectName}/1)`);
    }
    assertTargetUsable(target);
    const targetInstance = target.instance;

    const configFile = target.project.configFile ?? GROVE_CONFIG_FILE;
    const sourceConfig = loadRepoConfig(target.project.source, configFile);
    assertPortContract(target.project.ports, sourceConfig?.ports);
    const settings = loadSettings();
    const context = {
      projectName: target.projectName,
      source: target.project.source,
      target: target.root,
      slot: targetSlot(target),
      instanceName: targetInstance.name,
      ports: computePorts(sourceConfig?.ports ?? target.project.ports, targetSlot(target)),
    };

    // Build the shared environment and validate every configured repository
    // before any setup phase can rewrite the target. --force permits dirty
    // worktrees, not a missing checkout.
    groveContextEnv(context, process.env, settings);
    assertRepositoriesReadyForApply(target.root, sourceConfig?.repos, options.force === true);

    console.log(`Applying ${target.projectName}/${targetInstance.name} (slot ${targetInstance.slot})`);
    applyExistingCheckoutSetup(
      target.project.source,
      target.root,
      sourceConfig,
      target.project.ports,
      configFile,
      context,
      settings,
    );

    const applied: GroveApplied = {
      configHash: configHash(sourceConfig),
      at: new Date().toISOString(),
      code: describeAppliedCode(target.root, sourceConfig?.repos),
    };
    await withRegistryLock(async (registry) => {
      const instance = registry.projects[target.projectName]?.instances.find((candidate) =>
        candidate.name === targetInstance.name &&
        candidate.slot === targetInstance.slot &&
        candidate.path === targetInstance.path,
      );
      if (!instance) throw new Error(`${target.projectName}/${targetInstance.name} is no longer registered`);
      instance.applied = applied;
      await saveRegistry(registry);
    });

    console.log(`Applied: ${target.projectName}/${targetInstance.name}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
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

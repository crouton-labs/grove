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
    const settings = loadSettings();
    const context = {
      projectName: target.projectName,
      source: target.project.source,
      target: target.root,
      slot: targetSlot(target),
      instanceName: targetInstance.name,
      ports: computePorts(target.project.ports, targetSlot(target)),
    };

    // Build the shared environment before any setup phase so malformed secret
    // files refuse the apply before it rewrites a target.
    groveContextEnv(context, process.env, settings);
    if (!options.force) assertNoTrackedChanges(target.root, sourceConfig?.repos);

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

function assertNoTrackedChanges(root: string, repos: Record<string, unknown> | undefined): void {
  const repoPaths = repos ? Object.keys(repos).map((repo) => path.join(root, repo)) : [root];
  const dirty: string[] = [];
  for (const repoPath of repoPaths) {
    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      throw new Error(`cannot apply: configured repo is not a git checkout: ${repoPath}`);
    }
    let status: string;
    try {
      status = execFileSync("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"], {
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

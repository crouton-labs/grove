import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { GROVE_CONFIG_FILE, isWithinRoot, loadRepoConfig, resolveDevCommand } from "../config.js";
import { groveContextEnv } from "../context.js";
import { computePorts } from "../ports.js";
import { loadRegistry } from "../registry.js";
import type { GroveProjectConfig, GroveInstance } from "../types.js";

type DevTarget = {
  project: GroveProjectConfig;
  projectName: string;
  root: string;
  instance?: GroveInstance;
};

export function dev(args: string[]): void {
  try {
    const target = resolveTarget(process.cwd());
    const config = loadRepoConfig(target.root, target.project.configFile ?? GROVE_CONFIG_FILE);
    if (!config?.devCommand) {
      throw new Error(`no devCommand configured for ${target.root}`);
    }

    const command = resolveDevCommand(target.root, config.devCommand);
    const slot = target.instance?.slot ?? 0;
    const instanceName = target.instance?.name ?? target.projectName;
    const ports = computePorts(target.project.ports, slot);
    const result = spawnSync(command, args, {
      cwd: target.root,
      env: groveContextEnv({
        source: target.project.source,
        target: target.root,
        slot,
        instanceName,
        ports,
      }),
      stdio: "inherit",
    });

    if (result.error) throw new Error(`failed to run devCommand: ${result.error.message}`);
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function resolveTarget(cwd: string): DevTarget {
  const registry = loadRegistry();
  const resolvedCwd = fs.realpathSync(cwd);
  const candidates: Array<DevTarget & { rootLength: number }> = [];

  for (const [projectName, project] of Object.entries(registry.projects)) {
    addCandidate(candidates, resolvedCwd, project, projectName, project.source);
    for (const instance of project.instances) {
      addCandidate(candidates, resolvedCwd, project, projectName, instance.path, instance);
    }
  }

  candidates.sort((a, b) => b.rootLength - a.rootLength);
  const match = candidates[0];
  if (!match) {
    throw new Error(`current directory is outside a registered project root: ${cwd}`);
  }
  return match;
}

function addCandidate(
  candidates: Array<DevTarget & { rootLength: number }>,
  cwd: string,
  project: GroveProjectConfig,
  projectName: string,
  rootPath: string,
  instance?: GroveInstance,
): void {
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(rootPath);
  } catch {
    return;
  }
  if (!isWithinRoot(resolvedRoot, cwd)) return;
  const targetRoot = path.resolve(rootPath);
  candidates.push({ project, projectName, root: targetRoot, instance, rootLength: resolvedRoot.length });
}

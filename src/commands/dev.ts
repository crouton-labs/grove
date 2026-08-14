import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { GROVE_CONFIG_FILE, GROVE_CONFIG_EXAMPLE, isWithinRoot, loadRepoConfig, resolveDevCommand } from "../config.js";
import { groveContextEnv } from "../context.js";
import { computePorts } from "../ports.js";
import { loadRegistry } from "../registry.js";
import { stateNotAppliedError } from "../state.js";
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
    if (!target) {
      // Outside any registered root there is no repo CLI to forward to — not
      // even for -h, since help itself comes from the project's devCommand.
      // Explain the dispatch contract instead of failing bare; a help request
      // gets the explanation as its answer (exit 0), anything else errors.
      const help = args.includes("-h") || args.includes("--help");
      const out = help ? console.log : console.error;
      if (!help) out(`Error: current directory is outside a registered project root: ${process.cwd()}`);
      out(`dev — dispatches to the current project's own development command.
Inside a registered project, \`dev [args...]\` runs the executable named by
\`devCommand\` in its ${GROVE_CONFIG_FILE} (so \`dev -h\` shows that project's
own services and verbs).

This directory is not inside a registered project. To set one up:
  1. Add ${GROVE_CONFIG_FILE} and the executable it names.
  2. Run: grove register <project-root>

${GROVE_CONFIG_EXAMPLE}`);
      process.exitCode = help ? 0 : 1;
      return;
    }
    if (target.instance?.needsState) {
      throw new Error(stateNotAppliedError(target.projectName, target.instance));
    }

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
    if (result.signal) {
      process.exitCode = 128 + os.constants.signals[result.signal];
      return;
    }
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function resolveTarget(cwd: string): DevTarget | undefined {
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
  return candidates[0];
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

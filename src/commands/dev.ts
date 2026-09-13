import os from "os";
import { spawnSync } from "child_process";
import { GROVE_CONFIG_FILE, GROVE_CONFIG_EXAMPLE, loadRepoConfig, resolveDevCommand } from "../config.js";
import { groveContextEnv } from "../context.js";
import { computePorts } from "../ports.js";
import { assertTargetUsable, printResolvedTarget, resolveCommandTarget, targetSlot } from "../target.js";

export function dev(args: string[]): void {
  try {
    const { target, instance, forwarded } = parseTarget(args);
    const resolved = resolveCommandTarget({ target, instance, cwd: process.cwd() });
    const groveTarget = resolved.target;
    assertTargetUsable(groveTarget);
    printResolvedTarget(resolved);
    const config = loadRepoConfig(groveTarget.root, groveTarget.project.configFile ?? GROVE_CONFIG_FILE);
    if (!config?.devCommand) throw new Error(`no devCommand configured for ${groveTarget.root}`);
    const command = resolveDevCommand(groveTarget.root, config.devCommand);
    const slot = targetSlot(groveTarget);
    const result = spawnSync(command, forwarded, {
      cwd: groveTarget.root,
      env: groveContextEnv({
        projectName: groveTarget.projectName,
        source: groveTarget.project.source,
        target: groveTarget.root,
        slot,
        instanceName: groveTarget.instance?.name ?? groveTarget.projectName,
        ports: computePorts(groveTarget.project.ports, slot),
      }),
      stdio: "inherit",
    });
    if (result.error) throw new Error(`failed to run devCommand: ${result.error.message}`);
    if (result.signal) { process.exitCode = 128 + os.constants.signals[result.signal]; return; }
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function parseTarget(args: string[]): { target?: string; instance?: string; forwarded: string[] } {
  let target: string | undefined;
  let instance: string | undefined;
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    if (value === "--at" || value === "--instance") {
      const next = args[index + 1];
      if (!next) throw new Error(`${value} requires a target such as northlight/2`);
      if (value === "--at") target = next; else instance = next;
      index += 2;
      continue;
    }
    if (value.startsWith("--at=")) { target = value.slice("--at=".length); index++; continue; }
    if (value.startsWith("--instance=")) { instance = value.slice("--instance=".length); index++; continue; }
    break;
  }
  if (target !== undefined && instance !== undefined) throw new Error("name the target once; use either --at or --instance <target>");
  return { target, instance, forwarded: args.slice(index) };
}

export function showOutsideProjectHelp(args: string[]): void {
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
}

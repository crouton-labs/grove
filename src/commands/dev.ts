import os from "os";
import { spawnSync } from "child_process";
import { GROVE_CONFIG_FILE, GROVE_CONFIG_EXAMPLE, loadRepoConfig, resolveDevCommand } from "../config.js";
import { groveContextEnv } from "../context.js";
import { computePorts } from "../ports.js";
import { assertTargetUsable, resolveTarget, targetSlot } from "../target.js";

export function dev(args: string[]): void {
  try {
    const { at, forwarded } = parseAt(args);
    const target = resolveTarget({ at, cwd: process.cwd() });
    if (!target) {
      showOutsideProjectHelp(forwarded);
      return;
    }
    assertTargetUsable(target);
    const config = loadRepoConfig(target.root, target.project.configFile ?? GROVE_CONFIG_FILE);
    if (!config?.devCommand) throw new Error(`no devCommand configured for ${target.root}`);

    const command = resolveDevCommand(target.root, config.devCommand);
    const slot = targetSlot(target);
    const result = spawnSync(command, forwarded, {
      cwd: target.root,
      env: groveContextEnv({
        source: target.project.source,
        target: target.root,
        slot,
        instanceName: target.instance?.name ?? target.projectName,
        ports: computePorts(target.project.ports, slot),
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

function parseAt(args: string[]): { at?: string; forwarded: string[] } {
  if (args[0] === "--at") {
    if (!args[1]) throw new Error("--at requires a target such as northlight/2");
    return { at: args[1], forwarded: args.slice(2) };
  }
  if (args[0]?.startsWith("--at=")) {
    const at = args[0].slice("--at=".length);
    if (!at) throw new Error("--at requires a target such as northlight/2");
    return { at, forwarded: args.slice(1) };
  }
  return { forwarded: args };
}

function showOutsideProjectHelp(args: string[]): void {
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

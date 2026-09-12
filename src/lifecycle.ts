import os from "os";
import { spawn, spawnSync, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import { GROVE_CONFIG_FILE, loadRepoConfig, resolveDevCommand, type LifecycleRole } from "./config.js";
import { groveContextEnv } from "./context.js";
import { computePorts } from "./ports.js";
import { assertTargetUsable, targetName, targetSlot, type GroveTarget } from "./target.js";
import type { GroveInstance } from "./types.js";

export interface LifecyclePlan {
  command: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface LifecycleRun {
  /** Resolves with the child's exit code, or 128 + signal when it was signalled. */
  exit: Promise<number>;
  interrupt: () => void;
}

/**
 * Resolve a lifecycle role into the argv grove will run. The mapping is read
 * from the project's registered source config, never from an instance's copy.
 */
export function planLifecycle(target: GroveTarget, role: LifecycleRole, allowedPending?: GroveInstance["pending"]): LifecyclePlan {
  assertTargetUsable(target, allowedPending);
  const sourceConfigFile = target.project.configFile ?? GROVE_CONFIG_FILE;
  const sourceConfig = loadRepoConfig(target.project.source, sourceConfigFile);
  const argv = sourceConfig?.lifecycle?.[role];
  if (!argv) {
    throw new Error(`${targetName(target)}: ${sourceConfigFile} declares no lifecycle.${role}. Add it, for example "lifecycle": { "${role}": ["service", "${role}"] }.`);
  }
  const targetConfig = loadRepoConfig(target.root, sourceConfigFile);
  if (!targetConfig?.devCommand) {
    throw new Error(`no devCommand configured for ${target.root}`);
  }
  return {
    command: resolveDevCommand(target.root, targetConfig.devCommand),
    argv,
    cwd: target.root,
    env: groveContextEnv({
      projectName: target.projectName,
      source: target.project.source,
      target: target.root,
      slot: targetSlot(target),
      instanceName: target.instance?.name ?? target.projectName,
      ports: computePorts(target.project.ports, targetSlot(target)),
    }),
  };
}

/** Run a lifecycle role with the caller's stdio, returning its exit code. */
export function dispatchLifecycle(target: GroveTarget, role: LifecycleRole, allowedPending?: GroveInstance["pending"]): number {
  const plan = planLifecycle(target, role, allowedPending);
  const result = spawnSync(plan.command, plan.argv, { cwd: plan.cwd, env: plan.env, stdio: "inherit" });
  if (result.error) throw new Error(`failed to run devCommand: ${result.error.message}`);
  if (result.signal) return 128 + os.constants.signals[result.signal];
  return result.status ?? 1;
}

/** Run a lifecycle role with its output captured line by line, for the TUI. */
export function runLifecycleCaptured(plan: LifecyclePlan, onLine: (line: string) => void): LifecycleRun {
  return captureChild(
    spawn(plan.command, plan.argv, { cwd: plan.cwd, env: plan.env, stdio: ["ignore", "pipe", "pipe"] }),
    onLine,
  );
}

/** Stream a piped child's merged output one line at a time. */
export function captureChild(child: ChildProcessByStdio<null, Readable, Readable>, onLine: (line: string) => void): LifecycleRun {
  let pending = "";
  const consume = (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", (error) => reject(new Error(`failed to run ${child.spawnfile}: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (pending) onLine(pending);
      resolve(signal ? 128 + os.constants.signals[signal] : code ?? 1);
    });
  });
  return { exit, interrupt: () => child.kill("SIGINT") };
}

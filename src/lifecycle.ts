import os from "os";
import { spawnSync } from "child_process";
import { GROVE_CONFIG_FILE, loadRepoConfig, resolveDevCommand, type LifecycleRole } from "./config.js";
import { groveContextEnv } from "./context.js";
import { computePorts } from "./ports.js";
import { assertTargetUsable, targetName, targetSlot, type GroveTarget } from "./target.js";

export function dispatchLifecycle(target: GroveTarget, role: LifecycleRole): void {
  assertTargetUsable(target);
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
  const command = resolveDevCommand(target.root, targetConfig.devCommand);
  const result = spawnSync(command, argv, {
    cwd: target.root,
    env: groveContextEnv({
      source: target.project.source,
      target: target.root,
      slot: targetSlot(target),
      instanceName: target.instance?.name ?? target.projectName,
      ports: computePorts(target.project.ports, targetSlot(target)),
    }),
    stdio: "inherit",
  });
  if (result.error) throw new Error(`failed to run devCommand: ${result.error.message}`);
  if (result.signal) {
    process.exitCode = 128 + os.constants.signals[result.signal];
    return;
  }
  process.exitCode = result.status ?? 1;
}

import { dispatchLifecycle } from "../lifecycle.js";
import { loadSettings } from "../settings.js";
import { withRegistryLock } from "../registry.js";
import { currentRegisteredTarget, runSequential, selectTargets, type TargetingOptions } from "../selection.js";
import { type LifecycleRole } from "../config.js";
import { killSessionOnStop } from "../tmux.js";

export async function runLifecycleCommand(
  role: LifecycleRole,
  targetOrProject: string | undefined,
  options: TargetingOptions,
): Promise<void> {
  try {
    // A malformed settings file must refuse before any stop lifecycle runs.
    const settings = role === "stop" ? loadSettings() : undefined;
    const selection = selectTargets(targetOrProject, options, process.cwd());
    const action = async (target: Parameters<typeof dispatchLifecycle>[0]) => {
      const current = await withRegistryLock((registry) => currentRegisteredTarget(registry, target));
      const exitCode = dispatchLifecycle(current, role);
      if (role === "stop" && exitCode === 0) {
        killSessionOnStop(current, settings!, (message) => console.error(message));
      }
      return exitCode;
    };
    process.exitCode = selection.fanOut
      ? await runSequential(selection.targets, action)
      : await action(selection.targets[0]);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

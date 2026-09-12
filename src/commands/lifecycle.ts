import { dispatchLifecycle } from "../lifecycle.js";
import { loadSettings } from "../settings.js";
import { runSequential, selectTargets, type TargetingOptions } from "../selection.js";
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
    const action = (target: Parameters<typeof dispatchLifecycle>[0]) => {
      const exitCode = dispatchLifecycle(target, role);
      if (role === "stop" && exitCode === 0) {
        killSessionOnStop(target, settings!, (message) => console.error(message));
      }
      return exitCode;
    };
    process.exitCode = selection.fanOut
      ? await runSequential(selection.targets, action)
      : action(selection.targets[0]);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

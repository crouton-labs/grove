import { dispatchLifecycle } from "../lifecycle.js";
import { loadSettings } from "../settings.js";
import { resolveTarget } from "../target.js";
import { killSessionOnStop } from "../tmux.js";

export function stop(targetRef: string): void {
  try {
    // Loaded first: a malformed settings file refuses before anything is stopped.
    const settings = loadSettings();
    const target = resolveTarget({ at: targetRef, cwd: process.cwd() })!;
    const exitCode = dispatchLifecycle(target, "stop");
    process.exitCode = exitCode;
    // Last, and only on success: the session being killed may be the caller's own.
    if (exitCode === 0) killSessionOnStop(target, settings, (message) => console.error(message));
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

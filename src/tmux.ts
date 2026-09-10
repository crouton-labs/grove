import { spawnSync } from "child_process";
import { targetSlot, type GroveTarget } from "./target.js";
import type { GroveSettings } from "./settings.js";

export function tmuxSessionName(target: GroveTarget): string {
  return `${target.projectName}-${targetSlot(target)}`;
}

function runTmux(args: string[]): { status: number; stderr: string } {
  const result = spawnSync("tmux", args, { encoding: "utf-8" });
  if (result.error) throw new Error(`tmux ${args.join(" ")}: ${result.error.message}`);
  return { status: result.status ?? 1, stderr: (result.stderr ?? "").trim() };
}

export function hasSession(name: string): boolean {
  return runTmux(["has-session", "-t", `=${name}`]).status === 0;
}

/** Create the session detached if it does not exist, then switch the current client to it. */
export function switchToSession(name: string, cwd: string): void {
  if (!hasSession(name)) {
    const created = runTmux(["new-session", "-d", "-s", name, "-c", cwd]);
    if (created.status !== 0) throw new Error(`tmux new-session ${name} failed: ${created.stderr || `exit ${created.status}`}`);
  }
  const switched = runTmux(["switch-client", "-t", `=${name}`]);
  if (switched.status !== 0) throw new Error(`tmux switch-client ${name} failed: ${switched.stderr || `exit ${switched.status}`}`);
}

/**
 * Kill a target's tmux session after its stop verb exited 0, when the setting is
 * on. Kills last, because the session may be the caller's own. A failed or
 * impossible kill warns and never changes the stop's exit code: the services
 * really did stop.
 */
export function killSessionOnStop(
  target: GroveTarget,
  settings: GroveSettings,
  warn: (message: string) => void,
): void {
  if (!settings.killTmuxSessionOnStop) return;
  const name = tmuxSessionName(target);
  try {
    if (!hasSession(name)) return;
    const killed = runTmux(["kill-session", "-t", `=${name}`]);
    if (killed.status !== 0) {
      warn(`Warning: tmux session ${name} was not killed: ${killed.stderr || `tmux kill-session exited ${killed.status}`}`);
    }
  } catch (error) {
    warn(`Warning: tmux session ${name} was not killed: ${(error as Error).message}`);
  }
}

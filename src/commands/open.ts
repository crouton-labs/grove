import { assertTargetUsable, resolveTarget, targetSlot, TargetNotFoundError } from "../target.js";
import { tmuxSessionName } from "../tmux.js";

export function open(targetRef: string | undefined, options: { json?: boolean }): void {
  try {
    const target = resolveTarget({ at: targetRef, cwd: process.cwd() });
    if (!target) throw new Error(`current directory is outside a registered project root: ${process.cwd()}`);
    assertTargetUsable(target);
    if (options.json) {
      console.log(JSON.stringify({
        project: target.projectName,
        name: target.instance?.name ?? target.projectName,
        slot: targetSlot(target),
        path: target.root,
        tmuxSession: tmuxSessionName(target),
      }));
    } else {
      console.log(target.root);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = error instanceof TargetNotFoundError ? 4 : 1;
  }
}

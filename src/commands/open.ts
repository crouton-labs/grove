import { assertTargetUsable, printResolvedTarget, resolveCommandTarget, resolveTarget, targetSlot, TargetNotFoundError, TargetUsageError } from "../target.js";
import { tmuxSessionName } from "../tmux.js";

export function open(targetRef: string | undefined, options: { instance?: string; json?: boolean }): void {
  try {
    // I5 deliberately distinguishes an outside directory from the G4 noninteractive fallback.
    const resolved = options.json && !targetRef && !options.instance && !process.env.GROVE_INSTANCE && !resolveTarget({ cwd: process.cwd() })
      ? (() => { throw new TargetNotFoundError(`current directory is outside a registered project root: ${process.cwd()}`); })()
      : resolveCommandTarget({ target: targetRef, instance: options.instance, cwd: process.cwd() });
    const target = resolved.target;
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
      printResolvedTarget(resolved);
      console.log(target.root);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = error instanceof TargetNotFoundError ? 4 : error instanceof TargetUsageError ? 2 : 1;
  }
}

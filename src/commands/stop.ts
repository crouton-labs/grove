import { dispatchLifecycle } from "../lifecycle.js";
import { resolveTarget } from "../target.js";

export function stop(targetRef: string): void {
  try {
    dispatchLifecycle(resolveTarget({ at: targetRef, cwd: process.cwd() })!, "stop");
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

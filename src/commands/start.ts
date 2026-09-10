import { dispatchLifecycle } from "../lifecycle.js";
import { resolveTarget } from "../target.js";

export function start(targetRef: string): void {
  try {
    process.exitCode = dispatchLifecycle(resolveTarget({ at: targetRef, cwd: process.cwd() })!, "start");
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

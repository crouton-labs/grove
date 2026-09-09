import { dispatchLifecycle } from "../lifecycle.js";
import { resolveTarget } from "../target.js";

export function status(targetRef: string): void {
  try {
    dispatchLifecycle(resolveTarget({ at: targetRef, cwd: process.cwd()})!, "status");
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

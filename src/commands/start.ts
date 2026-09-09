import { dispatchLifecycle } from "../lifecycle.js";
import { resolveTarget } from "../target.js";

export function start(targetRef: string): void {
  runLifecycle("start", targetRef);
}

function runLifecycle(role: "start", targetRef: string): void {
  try {
    dispatchLifecycle(resolveTarget({ at: targetRef, cwd: process.cwd() })!, role);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

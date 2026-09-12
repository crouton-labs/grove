import { runLifecycleCommand } from "./lifecycle.js";
import type { TargetingOptions } from "../selection.js";

export async function reset(targetOrProject: string | undefined, options: TargetingOptions): Promise<void> {
  await runLifecycleCommand("reset", targetOrProject, options);
}

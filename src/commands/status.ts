import { runLifecycleCommand } from "./lifecycle.js";
import type { TargetingOptions } from "../selection.js";

export async function status(targetOrProject: string | undefined, options: TargetingOptions): Promise<void> {
  await runLifecycleCommand("status", targetOrProject, options);
}

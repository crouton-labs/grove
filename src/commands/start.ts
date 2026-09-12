import { runLifecycleCommand } from "./lifecycle.js";
import type { TargetingOptions } from "../selection.js";

export async function start(targetOrProject: string | undefined, options: TargetingOptions): Promise<void> {
  await runLifecycleCommand("start", targetOrProject, options);
}

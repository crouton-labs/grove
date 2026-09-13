import { clearCurrent, loadCurrent, saveCurrent } from "../current.js";
import { resolveTargetFromRef, targetName, TargetNotFoundError } from "../target.js";

export function use(targetRef: string | undefined, options: { clear?: boolean }): void {
  try {
    if (options.clear) {
      if (targetRef) throw new Error("grove use --clear does not take a target");
      clearCurrent();
      console.log("Current instance cleared.");
      return;
    }
    if (!targetRef) throw new Error("grove use needs an instance target");
    const target = resolveTargetFromRef(targetRef);
    if (!target.instance) throw new Error(`${target.projectName} is the project source; grove use needs a planted instance`);
    const name = targetName(target);
    saveCurrent(name);
    console.log(`Current instance: ${name}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = error instanceof TargetNotFoundError ? 4 : 2;
  }
}

export function current(options: { json?: boolean }): void {
  try {
    const selected = loadCurrent();
    if (!selected) {
      if (options.json) console.log(JSON.stringify({ current: null, path: null }));
      else console.log("No current instance set.");
      return;
    }
    const target = resolveTargetFromRef(selected);
    if (!target.instance) throw new Error(`${selected} is not a planted instance`);
    if (options.json) console.log(JSON.stringify({ current: targetName(target), path: target.root }));
    else console.log(`Current instance: ${targetName(target)}\nPath: ${target.root}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = error instanceof TargetNotFoundError ? 4 : 1;
  }
}

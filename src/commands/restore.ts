import { saveRegistry, withRegistryLock } from "../registry.js";
import { confirm } from "../prompt.js";
import { currentRegisteredTarget, runSequential, selectTargets, type TargetingOptions } from "../selection.js";
import {
  applyRef,
  describeRef,
  instanceContext,
  resolveRef,
  pendingError,
} from "../state.js";
import type { GroveTarget } from "../target.js";

interface RestoreOptions extends TargetingOptions {
  force?: boolean;
  ignoreFingerprint?: boolean;
}

export async function restore(
  targetOrProject: string | undefined,
  refOrUndefined: string | undefined,
  options: RestoreOptions,
): Promise<void> {
  try {
    const selecting = options.selector !== undefined || options.all === true;
    const stateRef = selecting && refOrUndefined === undefined ? targetOrProject : refOrUndefined;
    const scope = selecting && refOrUndefined === undefined ? undefined : targetOrProject;
    if (!stateRef) throw new Error("specify the state ref to restore");
    const selection = selectTargets(scope, options, process.cwd());
    process.exitCode = selection.fanOut
      ? await runSequential(selection.targets, (target) => restoreTarget(target, stateRef, options))
      : await restoreTarget(selection.targets[0], stateRef, options);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

export async function restoreTarget(
  target: GroveTarget,
  stateRef: string,
  options: Pick<RestoreOptions, "force" | "ignoreFingerprint">,
): Promise<number> {
  if (!target.instance) {
    throw new Error(`${target.projectName} is the project source; grove restore needs a planted instance`);
  }
  const { project, projectName, instance } = target;
  if (instance.pending) throw new Error(pendingError(projectName, instance));
  const dest = instanceContext(project, projectName, instance.name);
  const ref = resolveRef(projectName, project, stateRef);

  console.log(`Restoring ${projectName}/${instance.name}`);
  console.log(`  Target: ${dest.target}`);
  console.log(`  Slot: ${dest.slot}`);
  console.log(`  From: ${describeRef(ref)}`);

  if (!options.force) {
    if (!process.stdin.isTTY) {
      throw new Error("non-interactive shell. Use --force to skip confirmation.");
    }
    const ok = await confirm(`\nThis replaces the current state of ${projectName}/${instance.name}. Proceed? (y/N) `);
    if (!ok) {
      console.log("Cancelled.");
      return 0;
    }
  }

  console.log("");
  // Keep uproot from replacing this slot while stateCommand changes its state.
  await withRegistryLock(async (registry) => {
    const current = currentRegisteredTarget(registry, target);
    const currentInstance = current.instance!;
    if (currentInstance.pending) throw new Error(pendingError(current.projectName, currentInstance));
    const currentDest = instanceContext(current.project, current.projectName, currentInstance.name);
    const currentRef = resolveRef(current.projectName, current.project, stateRef);
    applyRef(current.project, currentRef, currentDest, options.ignoreFingerprint === true);
    if (currentInstance.needsState) {
      delete currentInstance.needsState;
      await saveRegistry(registry);
    }
  });

  console.log("");
  console.log(`Restored ${projectName}/${instance.name} from ${describeRef(ref)}.`);
  return 0;
}

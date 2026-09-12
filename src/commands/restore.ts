import { randomUUID } from "crypto";
import { saveRegistry, withRegistryLock } from "../registry.js";
import { confirm } from "../prompt.js";
import { currentRegisteredTarget, runSequential, selectTargets, type TargetingOptions } from "../selection.js";
import {
  describeRef,
  instanceContext,
  resolveRef,
  activePendingOperationError,
  isPendingInstanceOperationActive,
  pendingError,
  sameRestoreOperation,
  applyRef,
} from "../state.js";
import type { GrovePendingOperation } from "../types.js";
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
  if (instance.pending && instance.pending !== "restoring") throw new Error(pendingError(projectName, instance));
  const dest = instanceContext(project, projectName, instance.name);
  const ref = resolveRef(projectName, project, stateRef, true);
  const sourceInstanceName = liveSourceInstanceName(ref);
  const restore = { target: instance.name, ref: stateRef, source: sourceInstanceName };
  assertRestoreCanResume(projectName, instance, restore);

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
  const operationId = randomUUID();
  const operation = { id: operationId, pid: process.pid };
  const reserved = await withRegistryLock(async (registry) => {
    const current = currentRegisteredTarget(registry, target);
    const currentInstance = current.instance!;
    const currentRef = resolveRef(current.projectName, current.project, stateRef, true);
    const currentSourceInstanceName = liveSourceInstanceName(currentRef);
    const currentRestore = { target: currentInstance.name, ref: stateRef, source: currentSourceInstanceName };
    assertRestoreCanResume(current.projectName, currentInstance, currentRestore);

    const sourceInstance = currentSourceInstanceName === undefined
      ? undefined
      : current.project.instances.find((candidate) => candidate.name === currentSourceInstanceName);
    if (currentSourceInstanceName !== undefined && !sourceInstance) {
      throw new Error(`${current.projectName}/${currentSourceInstanceName} is no longer registered`);
    }
    if (sourceInstance && sourceInstance !== currentInstance) {
      if (sourceInstance.pending && sourceInstance.pending !== "restoring") {
        throw new Error(pendingError(current.projectName, sourceInstance));
      }
      assertRestoreCanResume(current.projectName, sourceInstance, currentRestore);
      reserveRestore(sourceInstance, operation, currentRestore);
    }
    reserveRestore(currentInstance, operation, currentRestore);
    await saveRegistry(registry);
    return {
      current,
      currentDest: instanceContext(current.project, current.projectName, currentInstance.name),
      ref: currentRef,
      sourceInstanceName: currentSourceInstanceName,
    };
  });

  applyRef(reserved.current.project, reserved.ref, reserved.currentDest, options.ignoreFingerprint === true);

  await withRegistryLock(async (registry) => {
    const current = currentRegisteredTarget(registry, target);
    const currentInstance = current.instance!;
    assertRestoreOwnership(current.projectName, currentInstance, operationId);
    delete currentInstance.pending;
    delete currentInstance.pendingOperation;
    delete currentInstance.needsState;
    if (reserved.sourceInstanceName !== undefined && reserved.sourceInstanceName !== currentInstance.name) {
      const sourceInstance = current.project.instances.find((candidate) => candidate.name === reserved.sourceInstanceName);
      if (!sourceInstance) throw new Error(`${current.projectName}/${reserved.sourceInstanceName} is no longer registered`);
      assertRestoreOwnership(current.projectName, sourceInstance, operationId);
      delete sourceInstance.pending;
      delete sourceInstance.pendingOperation;
    }
    await saveRegistry(registry);
  });

  console.log("");
  console.log(`Restored ${projectName}/${instance.name} from ${describeRef(reserved.ref)}.`);
  return 0;
}

function liveSourceInstanceName(ref: ReturnType<typeof resolveRef>): string | undefined {
  return ref.kind === "live" && ref.label !== "@source" ? ref.context.instanceName : undefined;
}

function assertRestoreCanResume(
  projectName: string,
  instance: NonNullable<GroveTarget["instance"]>,
  restore: NonNullable<GrovePendingOperation["restore"]>,
): void {
  if (!instance.pending) return;
  if (instance.pending !== "restoring") throw new Error(pendingError(projectName, instance));
  if (isPendingInstanceOperationActive(instance)) throw new Error(activePendingOperationError(projectName, instance));
  if (instance.pendingOperation && !sameRestoreOperation(instance.pendingOperation, restore)) {
    throw new Error(`${projectName}/${instance.name} is waiting for a different restore. ${pendingError(projectName, instance)}`);
  }
}

function reserveRestore(
  instance: NonNullable<GroveTarget["instance"]>,
  operation: Pick<GrovePendingOperation, "id" | "pid">,
  restore: NonNullable<GrovePendingOperation["restore"]>,
): void {
  instance.pending = "restoring";
  instance.pendingOperation = { ...operation, restore };
}

function assertRestoreOwnership(
  projectName: string,
  instance: NonNullable<GroveTarget["instance"]>,
  operationId: string,
): void {
  if (instance.pending !== "restoring" || instance.pendingOperation?.id !== operationId) {
    throw new Error(`${projectName}/${instance.name} is no longer being restored by this command`);
  }
}

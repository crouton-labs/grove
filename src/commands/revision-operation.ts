import { randomUUID } from "crypto";
import { saveRegistry, withRegistryLock } from "../registry.js";
import { currentRegisteredTarget } from "../selection.js";
import { activePendingOperationError, isPendingInstanceOperationActive } from "../state.js";
import { assertTargetUsable, type GroveTarget } from "../target.js";

export type RevisionOperation = "rolling-out" | "rolling-back";

export interface ReservedRevisionOperation {
  target: GroveTarget;
  id: string;
  pending: RevisionOperation;
}

/** Reserve an instance while a revision-changing command runs outside the registry lock. */
export async function reserveRevisionOperation(target: GroveTarget, pending: RevisionOperation): Promise<ReservedRevisionOperation> {
  const id = randomUUID();
  const current = await withRegistryLock(async (registry) => {
    const registered = currentRegisteredTarget(registry, target);
    if (!registered.instance) {
      throw new Error(`${registered.projectName} is the project source and has no revision history`);
    }
    assertTargetUsable(registered, pending);
    if (registered.instance.pending === pending && isPendingInstanceOperationActive(registered.instance)) {
      throw new Error(activePendingOperationError(registered.projectName, registered.instance));
    }
    registered.instance.pending = pending;
    registered.instance.pendingOperation = { id, pid: process.pid };
    await saveRegistry(registry);
    return registered;
  });
  return { target: current, id, pending };
}

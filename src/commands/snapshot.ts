import { printResolvedTarget, resolveCommandTarget } from "../target.js";
import { formatBytes, instanceContext, stateNotAppliedError, pendingError, writeSnapshot } from "../state.js";

interface SnapshotOptions { force?: boolean; instance?: string }

export async function snapshot(targetRef: string | undefined, name: string, options: SnapshotOptions) {
  try {
    const resolved = resolveCommandTarget({ target: targetRef, instance: options.instance, cwd: process.cwd() });
    const target = resolved.target;
    if (!target.instance) throw new Error(`${target.projectName} is the project source; grove snapshot needs a planted instance`);
    printResolvedTarget(resolved);
    const instance = target.instance;
    if (instance.pending) throw new Error(pendingError(target.projectName, instance));
    if (instance.needsState) throw new Error(stateNotAppliedError(target.projectName, instance));
    const context = instanceContext(target.project, target.projectName, instance.name);
    console.log(`Capturing ${target.projectName}/${instance.name} → "${name}"`);
    console.log(`  Source: ${context.target}`);
    console.log(`  Slot: ${context.slot}`);
    console.log("");
    const meta = writeSnapshot(target.projectName, target.project, context, name, options.force === true);
    console.log("");
    console.log(`Snapshot "${meta.name}" (${formatBytes(meta.bytes)})`);
    if (meta.fingerprint) console.log(`  Fingerprint: ${meta.fingerprint}`);
    console.log(`  Restore with: grove restore ${target.projectName}/<instance> ${meta.name}`);
    console.log(`  Plant with:   grove plant ${target.projectName} --from ${meta.name}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

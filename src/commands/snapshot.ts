import { loadRegistry } from "../registry.js";
import {
  findInstance,
  formatBytes,
  instanceContext,
  parseInstanceRef,
  stateNotAppliedError,
  writeSnapshot,
} from "../state.js";

interface SnapshotOptions {
  force?: boolean;
}

export async function snapshot(ref: string, name: string, options: SnapshotOptions) {
  try {
    const [projectName, instanceName] = parseInstanceRef(ref);
    const registry = loadRegistry();
    const project = registry.projects[projectName];
    if (!project) {
      throw new Error(`project "${projectName}" not registered`);
    }

    const instance = findInstance(project, projectName, instanceName);
    if (instance.needsState) {
      throw new Error(stateNotAppliedError(projectName, instance));
    }

    const context = instanceContext(project, projectName, instanceName);

    console.log(`Capturing ${projectName}/${instanceName} → "${name}"`);
    console.log(`  Source: ${context.target}`);
    console.log(`  Slot: ${context.slot}`);
    console.log("");

    const meta = writeSnapshot(projectName, project, context, name, options.force === true);

    console.log("");
    console.log(`Snapshot "${meta.name}" (${formatBytes(meta.bytes)})`);
    if (meta.fingerprint) console.log(`  Fingerprint: ${meta.fingerprint}`);
    console.log(`  Restore with: grove restore ${projectName}/<instance> ${meta.name}`);
    console.log(`  Plant with:   grove plant ${projectName} --from ${meta.name}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

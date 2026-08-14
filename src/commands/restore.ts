import { loadRegistry } from "../registry.js";
import { confirm } from "../prompt.js";
import { applyRef, describeRef, instanceContext, parseInstanceRef, resolveRef } from "../state.js";

interface RestoreOptions {
  force?: boolean;
  ignoreFingerprint?: boolean;
}

export async function restore(instanceRef: string, stateRef: string, options: RestoreOptions) {
  try {
    const [projectName, instanceName] = parseInstanceRef(instanceRef);
    const registry = loadRegistry();
    const project = registry.projects[projectName];
    if (!project) {
      throw new Error(`project "${projectName}" not registered`);
    }

    const dest = instanceContext(project, projectName, instanceName);
    const ref = resolveRef(projectName, project, stateRef);

    console.log(`Restoring ${projectName}/${instanceName}`);
    console.log(`  Target: ${dest.target}`);
    console.log(`  Slot: ${dest.slot}`);
    console.log(`  From: ${describeRef(ref)}`);

    if (!options.force) {
      if (!process.stdin.isTTY) {
        console.error(
          "Error: non-interactive shell. Use --force to skip confirmation.",
        );
        process.exitCode = 1;
        return;
      }
      const ok = await confirm(
        `\nThis replaces the current state of ${projectName}/${instanceName}. Proceed? (y/N) `,
      );
      if (!ok) {
        console.log("Cancelled.");
        return;
      }
    }

    console.log("");
    applyRef(project, ref, dest, options.ignoreFingerprint === true);

    console.log("");
    console.log(`Restored ${projectName}/${instanceName} from ${describeRef(ref)}.`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

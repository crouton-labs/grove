import { loadRegistry } from "../registry.js";
import { formatBytes, listSnapshots, projectStatesDir, removeSnapshot } from "../state.js";

interface StatesOptions {
  rm?: string;
}

export async function states(project: string | undefined, options: StatesOptions) {
  try {
    const registry = loadRegistry();

    if (options.rm) {
      if (!project) {
        throw new Error("--rm needs a project: grove states <project> --rm <name>");
      }
      if (!registry.projects[project]) {
        throw new Error(`project "${project}" not registered`);
      }
      if (!removeSnapshot(project, options.rm)) {
        throw new Error(`no snapshot "${options.rm}" for project "${project}"`);
      }
      console.log(`Removed snapshot ${project}/${options.rm}.`);
      return;
    }

    const names = project ? [project] : Object.keys(registry.projects);
    if (!names.length) {
      console.log("No projects registered.");
      return;
    }
    if (project && !registry.projects[project]) {
      throw new Error(`project "${project}" not registered`);
    }

    let total = 0;
    for (const name of names) {
      const snapshots = listSnapshots(name);
      if (!snapshots.length) {
        // Listing every project would otherwise be a wall of empty headings.
        if (project) console.log(`No snapshots for "${name}". Capture one with: grove snapshot ${name}/<instance> <snapshot-name>`);
        continue;
      }
      total += snapshots.length;
      console.log(`${name}  (${projectStatesDir(name)})`);
      for (const meta of snapshots) {
        const from = `${meta.instance} (slot ${meta.slot})`;
        console.log(
          `  ${meta.name.padEnd(24)} ${formatBytes(meta.bytes).padStart(7)}  from ${from}  ${meta.created}`,
        );
        if (meta.fingerprint) console.log(`  ${" ".repeat(24)} ${meta.fingerprint}`);
      }
      console.log("");
    }

    if (!project && total === 0) {
      console.log("No snapshots stored.");
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

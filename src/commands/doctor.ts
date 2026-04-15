import fs from "fs";
import { loadRegistry, saveRegistry } from "../registry.js";

export async function doctor(project?: string) {
  const registry = loadRegistry();
  let totalFixed = 0;

  const names = project ? [project] : Object.keys(registry.projects);

  if (names.length === 0) {
    console.log("No projects registered.");
    return;
  }

  for (const name of names) {
    const proj = registry.projects[name];
    if (!proj) {
      console.error(`Unknown project: ${name}`);
      continue;
    }

    console.log(`Checking ${name}...`);

    if (!fs.existsSync(proj.source)) {
      console.log(`  \x1b[33m⚠\x1b[0m Source missing: ${proj.source}`);
    } else {
      console.log(`  \x1b[32m✓\x1b[0m Source: ${proj.source}`);
    }

    const zombieIdxs: number[] = [];
    for (let i = 0; i < proj.instances.length; i++) {
      const inst = proj.instances[i];
      if (fs.existsSync(inst.path)) {
        console.log(`  \x1b[32m✓\x1b[0m ${inst.name} → ${inst.path}`);
      } else {
        console.log(
          `  \x1b[31m✗\x1b[0m ${inst.name} → ${inst.path} (zombie)`,
        );
        zombieIdxs.push(i);
      }
    }

    if (zombieIdxs.length) {
      for (const idx of zombieIdxs.reverse()) {
        proj.instances.splice(idx, 1);
      }
      totalFixed += zombieIdxs.length;
      console.log(
        `  Pruned ${zombieIdxs.length} zombie${zombieIdxs.length > 1 ? "s" : ""}.`,
      );
    }
  }

  if (totalFixed > 0) {
    saveRegistry(registry);
    console.log(`\nFixed ${totalFixed} issue(s).`);
  } else {
    console.log("\nAll clear.");
  }
}

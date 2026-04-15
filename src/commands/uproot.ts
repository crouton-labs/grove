import fs from "fs";
import readline from "readline";
import { loadRegistry, saveRegistry } from "../registry.js";
import { computePorts } from "../ports.js";

interface UprootOptions {
  force?: boolean;
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export async function uproot(ref: string, options: UprootOptions) {
  const parts = ref.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    console.error(
      'Error: specify instance as project/name (e.g. "grove uproot northlight/my-env")',
    );
    process.exit(1);
  }
  const [project, instanceName] = parts;

  const registry = loadRegistry();
  const proj = registry.projects[project];
  if (!proj) {
    console.error(`Error: project "${project}" not registered.`);
    process.exit(1);
  }

  const idx = proj.instances.findIndex((i) => i.name === instanceName);
  if (idx === -1) {
    console.error(
      `Error: instance "${instanceName}" not found in project "${project}".`,
    );
    if (proj.instances.length) {
      console.error("Instances:");
      for (const i of proj.instances) {
        console.error(`  ${project}/${i.name}`);
      }
    }
    process.exit(1);
  }

  const instance = proj.instances[idx];
  const exists = fs.existsSync(instance.path);

  console.log(`Uprooting ${project}/${instanceName}`);
  console.log(`  Path: ${instance.path}${exists ? "" : " (already gone)"}`);
  console.log(`  Slot: ${instance.slot}`);

  const ports = computePorts(proj.ports, instance.slot);

  if (!options.force) {
    if (!process.stdin.isTTY) {
      console.error("Error: non-interactive shell. Use --force to skip confirmation.");
      process.exit(1);
    }
    const ok = await confirm("\nProceed? (y/N) ");
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  if (exists) {
    console.log(`Removing ${instance.path}...`);
    fs.rmSync(instance.path, { recursive: true, force: true });
  }

  proj.instances.splice(idx, 1);
  saveRegistry(registry);

  console.log(`\nUprooted ${project}/${instanceName}.`);

  // Print cleanup hints
  if (Object.keys(ports).length) {
    console.log("\nCleanup hints:");
    console.log("  Check for leftover processes:");
    for (const [svc, port] of Object.entries(ports)) {
      console.log(`    lsof -i :${port}  # ${svc}`);
    }
    console.log(`  Drop the slot database if applicable:`);
    console.log(
      `    psql "postgresql://postgres:vallum@localhost:5433/postgres" -c "DROP DATABASE IF EXISTS vallum_slot${instance.slot};"`,
    );
  }
}

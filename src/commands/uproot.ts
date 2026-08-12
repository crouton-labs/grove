import fs from "fs";
import { execSync } from "child_process";
import readline from "readline";
import { loadRegistry, saveRegistry } from "../registry.js";
import { computePorts, checkPort } from "../ports.js";
import { loadRepoConfig, resolveProjectPath } from "../config.js";
import { stopInstanceServices } from "../process.js";
import { regenerateAliases } from "../aliases.js";
import { groveContextEnv } from "../context.js";

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

  if (Object.keys(ports).length) {
    console.log(`  Ports:`);
    for (const [svc, port] of Object.entries(ports)) {
      const up = await checkPort(port);
      console.log(`    ${svc}: ${port} ${up ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m"}`);
    }
  }

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

  // --- Phase 1: Stop services ---
  console.log("\nStopping services...");
  const { killed, portsFreed } = await stopInstanceServices(instance.path, ports);

  if (killed > 0) {
    console.log(`  Killed ${killed} process${killed > 1 ? "es" : ""}.`);
  } else {
    console.log("  No running services found.");
  }

  if (!portsFreed) {
    console.log("\n\x1b[33m⚠\x1b[0m Some ports could not be freed. Continuing with teardown.");
  }

  // --- Phase 2: Run teardown script if configured ---
  if (exists) {
    const repoConfig = loadRepoConfig(instance.path, proj.configFile);
    const teardownScript = repoConfig?.teardownScript ?? proj.teardownScript;

    if (teardownScript) {
      const scriptPath = resolveProjectPath(instance.path, teardownScript);
      const fallbackPath = resolveProjectPath(proj.source, teardownScript);
      const resolvedPath = fs.existsSync(scriptPath) ? scriptPath : fs.existsSync(fallbackPath) ? fallbackPath : null;

      if (resolvedPath) {
        console.log(`\nRunning teardown script: ${teardownScript}`);
        const env = groveContextEnv({
          source: proj.source,
          target: instance.path,
          slot: instance.slot,
          instanceName,
          ports,
        });
        try {
          execSync(`bash "${resolvedPath}"`, {
            stdio: "inherit",
            cwd: instance.path,
            env,
          });
        } catch {
          console.error("  Warning: teardown script failed.");
        }
      }
    }
  }

  // --- Phase 3: Remove directory ---
  if (exists) {
    console.log(`\nRemoving ${instance.path}...`);
    fs.rmSync(instance.path, { recursive: true, force: true });
  }

  // --- Phase 4: Update registry ---
  proj.instances.splice(idx, 1);
  saveRegistry(registry);
  regenerateAliases(registry);

  console.log(`\nUprooted ${project}/${instanceName}.`);

  // Print remaining cleanup hint (database only — processes are handled)
  if (Object.keys(ports).length) {
    console.log(`\nCleanup hint — drop the slot database if applicable:`);
    console.log(
      `  psql "postgresql://postgres:vallum@localhost:5433/postgres" -c "DROP DATABASE IF EXISTS vallum_slot${instance.slot};"`,
    );
  }
}

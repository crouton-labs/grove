import fs from "fs";
import { loadRegistry, saveRegistry } from "../registry.js";
import { computePorts } from "../ports.js";
import { stopInstanceServices } from "../process.js";
import {
  GROVE_CONFIG_FILE,
  loadRepoConfig,
  resolveDevCommand,
  resolveStateCommand,
} from "../config.js";
import type { GroveProjectConfig } from "../types.js";

export async function doctor(project?: string) {
  const registry = loadRegistry();
  let totalFixed = 0;
  let failures = 0;

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
      if (!reportCommands(proj, proj.source, "source")) failures++;
    }

    const zombieIdxs: number[] = [];
    for (let i = 0; i < proj.instances.length; i++) {
      const inst = proj.instances[i];
      if (fs.existsSync(inst.path)) {
        console.log(`  \x1b[32m✓\x1b[0m ${inst.name} → ${inst.path}`);
        if (!reportCommands(proj, inst.path, inst.name)) failures++;
      } else {
        console.log(
          `  \x1b[31m✗\x1b[0m ${inst.name} → ${inst.path} (zombie)`,
        );

        // Kill any services still running for this zombie instance
        const ports = computePorts(proj.ports, inst.slot);
        console.log(`    Stopping zombie services...`);
        const { killed } = await stopInstanceServices(inst.path, ports);
        if (killed > 0) {
          console.log(`    Killed ${killed} zombie process${killed > 1 ? "es" : ""}.`);
        } else {
          console.log(`    No running services.`);
        }

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
  }
  if (failures > 0) {
    console.log(`\nFound ${failures} issue(s).`);
    process.exitCode = 1;
  } else if (totalFixed === 0) {
    console.log("\nAll clear.");
  }
}

/** Validate every configured executable for a root. Returns false on any failure. */
function reportCommands(project: GroveProjectConfig, root: string, label: string): boolean {
  let config;
  try {
    config = loadRepoConfig(root, project.configFile ?? GROVE_CONFIG_FILE);
  } catch (error) {
    console.log(`  \x1b[31m✗\x1b[0m ${label} config: ${(error as Error).message}`);
    return false;
  }
  if (!config) return true;

  const checks: Array<[string, string | undefined, (root: string, cmd: string) => string]> = [
    ["devCommand", config.devCommand, resolveDevCommand],
    ["stateCommand", config.stateCommand, resolveStateCommand],
  ];

  let ok = true;
  for (const [field, value, resolve] of checks) {
    if (!value) continue;
    try {
      resolve(root, value);
      console.log(`  \x1b[32m✓\x1b[0m ${label} ${field}: ${value}`);
    } catch (error) {
      console.log(`  \x1b[31m✗\x1b[0m ${label} ${field}: ${(error as Error).message}`);
      ok = false;
    }
  }
  return ok;
}

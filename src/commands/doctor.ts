import fs from "fs";
import { loadRegistry, saveRegistry, withRegistryLock } from "../registry.js";
import { computePorts } from "../ports.js";
import { stopInstanceServices } from "../process.js";
import {
  GROVE_CONFIG_FILE,
  loadRepoConfig,
  resolveDevCommand,
  resolveStateCommand,
} from "../config.js";
import { loadSettings } from "../settings.js";
import { configHash } from "../intent.js";
import { inspectScopedEnv } from "../env.js";
import { instanceContext, pendingResolution, sourceContext } from "../state.js";
import type { GroveExecutionContext } from "../context.js";
import { currentApplied, type GroveProjectConfig } from "../types.js";

export async function doctor(project?: string) {
  const registry = loadRegistry();
  let totalFixed = 0;
  let failures = 0;
  const zombies: Array<{ project: string; name: string }> = [];

  if (!checkSettings()) failures++;

  const names = project ? [project] : Object.keys(registry.projects);

  if (names.length === 0) {
    console.log("No projects registered.");
    if (failures > 0) process.exitCode = 1;
    return;
  }

  for (const name of names) {
    const proj = registry.projects[name];
    if (!proj) {
      console.error(`Unknown project: ${name}`);
      continue;
    }

    console.log(`Checking ${name}...`);
    if (!reportEnvFiles(sourceContext(proj, name), "source")) failures++;
    let sourceConfigHash: string | undefined;

    if (!fs.existsSync(proj.source)) {
      console.log(`  \x1b[33m⚠\x1b[0m Source missing: ${proj.source}`);
    } else {
      console.log(`  \x1b[32m✓\x1b[0m Source: ${proj.source}`);
      try {
        sourceConfigHash = configHash(loadRepoConfig(proj.source, proj.configFile ?? GROVE_CONFIG_FILE));
      } catch {
        // reportCommands below prints the config error with its source path.
      }
      if (!reportCommands(proj, proj.source, "source")) failures++;
    }

    for (const inst of proj.instances) {
      if (!reportEnvFiles(instanceContext(proj, name, inst.name), inst.name)) failures++;
      const exists = fs.existsSync(inst.path);
      if (inst.pending) {
        console.log(`  \x1b[33m⚠\x1b[0m ${inst.name} → ${inst.path} (${inst.pending}${exists ? "" : "; directory missing"})`);
        console.log(`    ${pendingResolution(name, inst)}`);
        failures++;
        continue;
      }
      if (exists) {
        console.log(`  \x1b[32m✓\x1b[0m ${inst.name} → ${inst.path}`);
        if (inst.needsState) {
          console.log(
            `    \x1b[33m⚠\x1b[0m state not applied — grove restore ${name}/${inst.name} ${inst.needsState}`,
          );
          failures++;
        }
        const applied = currentApplied(inst);
        if (applied && sourceConfigHash !== undefined && applied.configHash !== sourceConfigHash) {
          console.log(`    \x1b[33m⚠\x1b[0m built from older config — grove apply ${name}/${inst.name}`);
          failures++;
        }
        if (!reportCommands(proj, inst.path, inst.name)) failures++;
        continue;
      }

      console.log(`  \x1b[31m✗\x1b[0m ${inst.name} → ${inst.path} (zombie)`);
      const ports = computePorts(proj.ports, inst.slot);
      console.log("    Stopping zombie services...");
      const { killed } = await stopInstanceServices(inst.path, ports);
      if (killed > 0) {
        console.log(`    Killed ${killed} zombie process${killed > 1 ? "es" : ""}.`);
      } else {
        console.log("    No running services.");
      }
      zombies.push({ project: name, name: inst.name });
    }
  }

  if (zombies.length) {
    totalFixed = await withRegistryLock(async (currentRegistry) => {
      let fixed = 0;
      for (const zombie of zombies) {
        const currentProject = currentRegistry.projects[zombie.project];
        const index = currentProject?.instances.findIndex((instance) =>
          instance.name === zombie.name &&
          !instance.pending &&
          !fs.existsSync(instance.path),
        ) ?? -1;
        if (!currentProject || index === -1) continue;
        currentProject.instances.splice(index, 1);
        fixed++;
      }
      if (fixed > 0) await saveRegistry(currentRegistry);
      return fixed;
    });
    if (totalFixed > 0) console.log(`  Pruned ${totalFixed} zombie${totalFixed > 1 ? "s" : ""}.`);
  }

  if (totalFixed > 0) {
    console.log(`\nFixed ${totalFixed} issue(s).`);
  }
  if (failures > 0) {
    console.log(`\nFound ${failures} issue(s).`);
    process.exitCode = 1;
  } else if (totalFixed === 0) {
    console.log("\nAll clear.");
  }
}

/** Validate `~/.grove/settings.json`. Returns false when it is present and malformed. */
function checkSettings(): boolean {
  try {
    const settings = loadSettings();
    console.log(`\x1b[32m✓\x1b[0m Settings: machine ${settings.machine}, killTmuxSessionOnStop ${settings.killTmuxSessionOnStop}`);
    return true;
  } catch (error) {
    console.log(`\x1b[31m✗\x1b[0m Settings: ${(error as Error).message}`);
    return false;
  }
}

/** Report secret env files for one dispatch target without exposing their values. */
function reportEnvFiles(context: GroveExecutionContext, label: string): boolean {
  let ok = true;
  try {
    for (const file of inspectScopedEnv(context)) {
      if (!file.exists) {
        console.log(`  \x1b[90m-\x1b[0m ${label} ${file.scope} env: ${file.path} (missing)`);
        continue;
      }
      if (file.error) {
        console.log(`  \x1b[31m✗\x1b[0m ${label} ${file.scope} env: ${file.error.message}`);
        ok = false;
        continue;
      }
      const names = file.keys.length ? `: ${file.keys.join(", ")}` : "";
      console.log(`  \x1b[32m✓\x1b[0m ${label} ${file.scope} env: ${file.path} (${file.keys.length} key${file.keys.length === 1 ? "" : "s"}${names})`);
    }
  } catch (error) {
    console.log(`  \x1b[31m✗\x1b[0m ${label} env: ${(error as Error).message}`);
    ok = false;
  }
  return ok;
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

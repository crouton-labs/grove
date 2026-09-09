import path from "path";
import fs from "fs";
import { loadRegistry, saveRegistry, nextFreeSlot } from "../registry.js";
import { computePorts } from "../ports.js";
import { regenerateAliases } from "../aliases.js";
import { GROVE_CONFIG_FILE, loadRepoConfig } from "../config.js";
import { expandTilde } from "../paths.js";

interface AdoptOptions {
  slot?: string;
}

export async function adopt(
  project: string,
  instanceName: string,
  instancePath: string,
  options: AdoptOptions,
) {
  const registry = loadRegistry();
  const proj = registry.projects[project];
  if (!proj) {
    const available = Object.keys(registry.projects);
    console.error(`Error: project "${project}" not registered.`);
    if (available.length) console.error(`Registered projects: ${available.join(", ")}`);
    process.exit(1);
  }

  const config = loadRepoConfig(proj.source, proj.configFile ?? GROVE_CONFIG_FILE);
  const absPath = path.resolve(instancePath);
  const usedSlots = new Set(proj.instances.map((instance) => instance.slot));
  let slot: number;
  if (options.slot) {
    slot = parseInt(options.slot, 10);
    if (isNaN(slot) || slot < 1 || slot > 9) {
      console.error("Error: slot must be 1-9.");
      process.exit(1);
    }
  } else {
    slot = detectSlotFromEnv(absPath, proj.ports) ?? nextFreeSlot(usedSlots);
    if (slot > 9) {
      console.error("Error: no free slots (1-9).");
      process.exit(1);
    }
  }

  if (config?.nameIsSlot) {
    if (instanceName !== String(slot)) {
      console.error(`Error: ${project} declares nameIsSlot; its instances are named by slot number. Drop the name: grove adopt ${project} <slot> <path> --slot <slot>.`);
      process.exit(1);
    }
    const instancesDir = config.instancesDir
      ? path.resolve(proj.source, expandTilde(config.instancesDir))
      : path.dirname(proj.source);
    const expected = path.join(instancesDir, String(slot));
    const actual = fs.existsSync(absPath) ? fs.realpathSync(absPath) : absPath;
    const expectedPath = fs.existsSync(expected) ? fs.realpathSync(expected) : expected;
    if (actual !== expectedPath) {
      console.error(`Error: ${project} declares nameIsSlot; slot ${slot}'s instance must live at ${expected}, not ${absPath}.`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(absPath)) {
    console.error(`Error: path does not exist: ${absPath}`);
    process.exit(1);
  }
  if (proj.instances.find((instance) => instance.name === instanceName)) {
    console.error(`Error: instance "${instanceName}" already exists for project "${project}".`);
    process.exit(1);
  }
  if (proj.instances.find((instance) => instance.path === absPath)) {
    const existing = proj.instances.find((instance) => instance.path === absPath)!;
    console.error(`Error: path already tracked as "${existing.name}" (slot ${existing.slot}).`);
    process.exit(1);
  }
  if (usedSlots.has(slot)) {
    console.error(`Error: slot ${slot} already in use.`);
    process.exit(1);
  }

  const ports = computePorts(proj.ports, slot);
  proj.instances.push({ name: instanceName, path: absPath, slot, created: new Date().toISOString() });
  saveRegistry(registry);
  regenerateAliases(registry);

  console.log(`Adopted ${project}/${instanceName}`);
  console.log(`  Path: ${absPath}`);
  console.log(`  Slot: ${slot}`);
  if (Object.keys(ports).length) {
    console.log("  Ports:");
    for (const [svc, port] of Object.entries(ports)) console.log(`    ${svc}: ${port}`);
  }
}

function detectSlotFromEnv(
  instancePath: string,
  portDefs: Record<string, { base: number; offset: number }>,
): number | null {
  for (const rel of ["northlight-core/.env", ".env"]) {
    const envPath = path.join(instancePath, rel);
    if (!fs.existsSync(envPath)) continue;
    const match = fs.readFileSync(envPath, "utf-8").match(/^PORT=(\d+)/m);
    if (!match) continue;
    const foundPort = parseInt(match[1], 10);
    for (const def of Object.values(portDefs)) {
      if (def.offset === 0) continue;
      const remainder = foundPort - def.base;
      if (remainder > 0 && remainder % def.offset === 0) {
        const slot = remainder / def.offset;
        if (slot >= 1 && slot <= 9) {
          console.log(`  Detected slot ${slot} from PORT=${foundPort} in ${rel}`);
          return slot;
        }
      }
    }
  }
  return null;
}

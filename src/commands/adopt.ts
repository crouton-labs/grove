import path from "path";
import fs from "fs";
import { loadRegistry, saveRegistry, withRegistryLock, nextFreeSlot } from "../registry.js";
import { computePorts, formatSlotCap, maxSlot, parsePositiveSafeSlot } from "../ports.js";
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
  try {
    const initialProject = loadRegistry().projects[project];
    if (!initialProject) {
      throw new Error(`project "${project}" not registered`);
    }
    const absPath = path.resolve(instancePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`path does not exist: ${absPath}`);
    }
    const requestedSlot = options.slot === undefined ? undefined : parsePositiveSafeSlot(options.slot);
    if (options.slot !== undefined && requestedSlot === null) {
      throw new Error("slot must be a positive safe integer");
    }
    const detectedSlot = requestedSlot ?? detectSlotFromEnv(absPath, initialProject.ports);
    if (detectedSlot !== null && !Number.isSafeInteger(detectedSlot)) {
      throw new Error("detected slot must be a positive safe integer");
    }

    await withRegistryLock(async (registry) => {
      const proj = registry.projects[project];
      if (!proj) throw new Error(`project "${project}" is no longer registered`);

      const config = loadRepoConfig(proj.source, proj.configFile ?? GROVE_CONFIG_FILE);
      const usedSlots = new Set(proj.instances.map((instance) => instance.slot));
      const cap = maxSlot(proj.ports);
      const slot = detectedSlot ?? nextFreeSlot(usedSlots);
      if (!Number.isSafeInteger(slot) || slot < 1) {
        throw new Error("slot must be a positive safe integer");
      }
      if (slot > cap) {
        if (requestedSlot !== undefined) {
          throw new Error(`slot must be between 1 and ${formatSlotCap(cap)}`);
        }
        throw new Error(`no free slots (cap ${formatSlotCap(cap)})`);
      }

      if (config?.nameIsSlot) {
        if (instanceName !== String(slot)) {
          throw new Error(`${project} declares nameIsSlot; its instances are named by slot number. Drop the name: grove adopt ${project} <slot> <path> --slot <slot>`);
        }
        const instancesDir = config.instancesDir
          ? path.resolve(proj.source, expandTilde(config.instancesDir))
          : path.dirname(proj.source);
        const expected = path.join(instancesDir, String(slot));
        const actual = fs.realpathSync(absPath);
        const expectedPath = fs.existsSync(expected) ? fs.realpathSync(expected) : expected;
        if (actual !== expectedPath) {
          throw new Error(`${project} declares nameIsSlot; slot ${slot}'s instance must live at ${expected}, not ${absPath}`);
        }
      }

      if (proj.instances.find((instance) => instance.name === instanceName)) {
        throw new Error(`instance "${instanceName}" already exists for project "${project}"`);
      }
      if (proj.instances.find((instance) => instance.path === absPath)) {
        const existing = proj.instances.find((instance) => instance.path === absPath)!;
        throw new Error(`path already tracked as "${existing.name}" (slot ${existing.slot})`);
      }
      if (usedSlots.has(slot)) {
        throw new Error(`slot ${slot} already in use`);
      }

      const ports = computePorts(proj.ports, slot);
      proj.instances.push({ name: instanceName, path: absPath, slot, created: new Date().toISOString() });
      await saveRegistry(registry);
      regenerateAliases(registry);

      console.log(`Adopted ${project}/${instanceName}`);
      console.log(`  Path: ${absPath}`);
      console.log(`  Slot: ${slot}`);
      if (Object.keys(ports).length) {
        console.log("  Ports:");
        for (const [svc, port] of Object.entries(ports)) console.log(`    ${svc}: ${port}`);
      }
    });
  } catch (error) {
    console.error(`Error: ${(error as Error).message}.`);
    process.exitCode = 1;
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
    const foundPort = Number(match[1]);
    if (!Number.isSafeInteger(foundPort)) continue;
    for (const def of Object.values(portDefs)) {
      if (def.offset === 0) continue;
      const remainder = foundPort - def.base;
      if (remainder > 0 && remainder % def.offset === 0) {
        const slot = remainder / def.offset;
        if (Number.isSafeInteger(slot) && slot >= 1) {
          console.log(`  Detected slot ${slot} from PORT=${foundPort} in ${rel}`);
          return slot;
        }
      }
    }
  }
  return null;
}

import path from "path";
import fs from "fs";
import { loadRegistry, saveRegistry, nextFreeSlot } from "../registry.js";
import { computePorts } from "../ports.js";

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
    if (available.length) {
      console.error(`Registered projects: ${available.join(", ")}`);
    }
    process.exit(1);
  }

  const absPath = path.resolve(instancePath);
  if (!fs.existsSync(absPath)) {
    console.error(`Error: path does not exist: ${absPath}`);
    process.exit(1);
  }

  if (proj.instances.find((i) => i.name === instanceName)) {
    console.error(
      `Error: instance "${instanceName}" already exists for project "${project}".`,
    );
    process.exit(1);
  }

  if (proj.instances.find((i) => i.path === absPath)) {
    const existing = proj.instances.find((i) => i.path === absPath)!;
    console.error(
      `Error: path already tracked as "${existing.name}" (slot ${existing.slot}).`,
    );
    process.exit(1);
  }

  // Slot: explicit or auto-detect from .env, or next free
  const usedSlots = new Set(proj.instances.map((i) => i.slot));
  let slot: number;

  if (options.slot) {
    slot = parseInt(options.slot, 10);
    if (isNaN(slot) || slot < 1 || slot > 9) {
      console.error("Error: slot must be 1-9.");
      process.exit(1);
    }
    if (usedSlots.has(slot)) {
      console.error(`Error: slot ${slot} already in use.`);
      process.exit(1);
    }
  } else {
    // Try to detect slot from port values in .env files
    slot = detectSlotFromEnv(absPath, proj.ports) ?? nextFreeSlot(usedSlots);
  }

  const ports = computePorts(proj.ports, slot);

  proj.instances.push({
    name: instanceName,
    path: absPath,
    slot,
    created: new Date().toISOString(),
  });
  saveRegistry(registry);

  console.log(`Adopted ${project}/${instanceName}`);
  console.log(`  Path: ${absPath}`);
  console.log(`  Slot: ${slot}`);
  if (Object.keys(ports).length) {
    console.log(`  Ports:`);
    for (const [svc, port] of Object.entries(ports)) {
      console.log(`    ${svc}: ${port}`);
    }
  }
}

/**
 * Try to infer the slot number by reading PORT= from .env files
 * and reverse-computing against the registered port base/offsets.
 */
function detectSlotFromEnv(
  instancePath: string,
  portDefs: Record<string, { base: number; offset: number }>,
): number | null {
  // Look for a PORT= line in common .env locations
  const candidates = [
    "northlight-core/.env",
    ".env",
  ];

  for (const rel of candidates) {
    const envPath = path.join(instancePath, rel);
    if (!fs.existsSync(envPath)) continue;

    const content = fs.readFileSync(envPath, "utf-8");
    const match = content.match(/^PORT=(\d+)/m);
    if (!match) continue;

    const foundPort = parseInt(match[1], 10);

    // Try to match against each port def
    for (const def of Object.values(portDefs)) {
      if (def.offset === 0) continue;
      const remainder = foundPort - def.base;
      if (remainder > 0 && remainder % def.offset === 0) {
        const slot = remainder / def.offset;
        if (slot >= 1 && slot <= 9) {
          console.log(
            `  Detected slot ${slot} from PORT=${foundPort} in ${rel}`,
          );
          return slot;
        }
      }
    }
  }

  return null;
}

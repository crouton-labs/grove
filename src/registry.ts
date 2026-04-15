import fs from "fs";
import path from "path";
import os from "os";
import { GroveRegistry } from "./types.js";

export const GROVE_DIR = path.join(os.homedir(), ".grove");
const REGISTRY_PATH = path.join(GROVE_DIR, "grove.json");

export function loadRegistry(): GroveRegistry {
  fs.mkdirSync(GROVE_DIR, { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { projects: {} };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
}

export function saveRegistry(registry: GroveRegistry): void {
  fs.mkdirSync(GROVE_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

export function nextFreeSlot(usedSlots: Set<number>): number {
  let slot = 1;
  while (usedSlots.has(slot)) slot++;
  return slot;
}

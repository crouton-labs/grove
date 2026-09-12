import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { GroveRegistry } from "./types.js";

export const GROVE_DIR = path.join(os.homedir(), ".grove");
export const REGISTRY_PATH = path.join(GROVE_DIR, "grove.json");
export const REGISTRY_LOCK_PATH = path.join(GROVE_DIR, "grove.lock");

const LOCK_TIMEOUT_MS = 10_000;
interface RegistryLock {
  pid: number;
  token: string;
  contents: string;
}
let registryLock: RegistryLock | undefined;

export function loadRegistry(): GroveRegistry {
  fs.mkdirSync(GROVE_DIR, { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { projects: {} };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
}

/** Save is deliberately available only to the process that still owns the registry lock. */
export function saveRegistry(registry: GroveRegistry): void {
  if (!registryLock || readLockContents() !== registryLock.contents) {
    throw new Error("registry save requires ownership of the registry lock");
  }
  fs.mkdirSync(GROVE_DIR, { recursive: true });
  const temporaryPath = `${REGISTRY_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(registry, null, 2) + "\n");
  fs.renameSync(temporaryPath, REGISTRY_PATH);
}

/** Serialize registry read-modify-write operations across Grove processes. */
export async function withRegistryLock<T>(operation: (registry: GroveRegistry) => T | Promise<T>): Promise<T> {
  const lock = await acquireRegistryLock();
  registryLock = lock;
  try {
    return await operation(loadRegistry());
  } finally {
    registryLock = undefined;
    releaseRegistryLock(lock);
  }
}

export function nextFreeSlot(usedSlots: Set<number>): number {
  let slot = 1;
  while (usedSlots.has(slot)) slot++;
  return slot;
}

async function acquireRegistryLock(): Promise<RegistryLock> {
  fs.mkdirSync(GROVE_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 25;
  let holder = "unknown";

  while (true) {
    const lock: RegistryLock = {
      pid: process.pid,
      token: randomUUID(),
      contents: "",
    };
    lock.contents = `${lock.pid} ${lock.token}\n`;
    try {
      fs.writeFileSync(REGISTRY_LOCK_PATH, lock.contents, { flag: "wx" });
      return lock;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      const observed = readLock();
      holder = observed ? String(observed.pid) : "unknown";
      if (observed && !pidIsAlive(observed.pid)) {
        removeStaleLock(observed);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`registry lock is held at ${REGISTRY_LOCK_PATH} by pid ${holder}`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 500);
    }
  }
}

/** Remove a dead holder only when this exact file content is still present. */
function removeStaleLock(observed: RegistryLock): void {
  const claimPath = `${REGISTRY_LOCK_PATH}.${process.pid}.${randomUUID()}.claim`;
  try {
    fs.linkSync(REGISTRY_LOCK_PATH, claimPath);
    if (readFile(claimPath) !== observed.contents || readLockContents() !== observed.contents) return;
    fs.unlinkSync(REGISTRY_LOCK_PATH);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  } finally {
    try {
      fs.unlinkSync(claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function releaseRegistryLock(lock: RegistryLock): void {
  if (readLockContents() !== lock.contents) return;
  try {
    fs.unlinkSync(REGISTRY_LOCK_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readLock(): RegistryLock | null {
  const contents = readLockContents();
  if (contents === null) return null;
  const match = contents.match(/^(\d+) ([0-9a-f-]+)\n$/);
  if (!match) return null;
  return { pid: Number(match[1]), token: match[2], contents };
}

function readLockContents(): string | null {
  try {
    return readFile(REGISTRY_LOCK_PATH);
  } catch {
    return null;
  }
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

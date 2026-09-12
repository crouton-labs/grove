import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { GroveRegistry, type GroveInstance } from "./types.js";

export const GROVE_DIR = path.join(os.homedir(), ".grove");
export const REGISTRY_PATH = path.join(GROVE_DIR, "grove.json");
export const REGISTRY_LOCK_PATH = path.join(GROVE_DIR, "grove.lock");

const LOCK_TIMEOUT_MS = 10_000;

interface RegistryLock {
  token: string;
}

interface LockOwner {
  pid: number;
  token: string;
}

let registryLock: RegistryLock | undefined;

export function loadRegistry(): GroveRegistry {
  fs.mkdirSync(GROVE_DIR, { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { version: 2, projects: {} };
  }
  return upgradeRegistry(JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8")) as GroveRegistry);
}

/** Upgrade legacy registry shapes in memory; the next save publishes the normalized form. */
function upgradeRegistry(registry: GroveRegistry): GroveRegistry {
  if (registry.version === undefined) registry.version = 2;
  if (registry.version !== 2) {
    throw new Error(`unsupported registry version ${registry.version} at ${REGISTRY_PATH}`);
  }
  for (const project of Object.values(registry.projects)) {
    for (const instance of project.instances) {
      const legacy = instance as GroveInstance & { applied?: GroveInstance["history"][number] | null };
      instance.spec ??= { codeFrom: "configured", from: "baseline", labels: {} };
      const history = Array.isArray(instance.history) ? instance.history : [];
      if (legacy.applied && !history.some((record) => record.at === legacy.applied!.at)) {
        history.unshift(legacy.applied);
      }
      instance.history = history.slice(0, 10);
      delete legacy.applied;
    }
  }
  return registry;
}

/** Publish a registry update only while this process still owns the lock. */
export async function saveRegistry(registry: GroveRegistry): Promise<void> {
  const lock = registryLock;
  if (!lock) {
    throw new Error("registry save requires ownership of the registry lock");
  }

  const temporaryPath = `${REGISTRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(registry, null, 2) + "\n");
    if (readLockOwner()?.token !== lock.token) {
      throw new Error("registry save requires ownership of the registry lock");
    }
    fs.renameSync(temporaryPath, REGISTRY_PATH);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
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
  while (true) {
    const token = randomUUID();
    const temporaryPath = path.join(GROVE_DIR, `.grove.lock.${process.pid}.${token}.tmp`);
    let lockCreated = false;
    try {
      fs.writeFileSync(temporaryPath, `${process.pid} ${token}\n`);
      fs.linkSync(temporaryPath, REGISTRY_LOCK_PATH);
      lockCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    if (lockCreated) return { token };

    const owner = readLockOwner();
    if (owner && !isProcessAlive(owner.pid)) {
      removeLockIfOwned(owner.token);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`registry lock is held at ${REGISTRY_LOCK_PATH} by pid ${owner?.pid ?? "unknown"}`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 500);
  }
}

function releaseRegistryLock(lock: RegistryLock): void {
  removeLockIfOwned(lock.token);
}

function removeLockIfOwned(token: string): void {
  if (readLockOwner()?.token !== token) return;
  try {
    fs.unlinkSync(REGISTRY_LOCK_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readLockOwner(): LockOwner | undefined {
  try {
    const contents = fs.readFileSync(REGISTRY_LOCK_PATH, "utf-8");
    const match = contents.match(/^(\d+) ([0-9a-f-]+)\n$/);
    if (!match) return undefined;
    return { pid: Number(match[1]), token: match[2] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function isProcessAlive(pid: number): boolean {
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

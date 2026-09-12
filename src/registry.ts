import fs from "fs";
import path from "path";
import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import { GroveRegistry } from "./types.js";

export const GROVE_DIR = path.join(os.homedir(), ".grove");
export const REGISTRY_PATH = path.join(GROVE_DIR, "grove.json");
export const REGISTRY_LOCK_PATH = path.join(GROVE_DIR, "grove.lock");

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_PORT = 49152 + (createHash("sha256").update(GROVE_DIR).digest().readUInt16BE() % 16384);
const LOCK_HELPER = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const [registryPath, lockPath, token, port] = process.argv.slice(1);
let input = "";
const server = net.createServer();
const reply = (message) => process.stdout.write(message + "\n");
const save = (encoded) => {
  const temporaryPath = registryPath + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(temporaryPath, Buffer.from(encoded, "base64"));
    fs.renameSync(temporaryPath, registryPath);
    reply("OK");
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    reply("ERROR " + error.message);
  }
};
server.once("error", (error) => {
  if (error.code === "EADDRINUSE") {
    process.stdout.write("BUSY\n", () => process.exit(1));
  } else {
    console.error(error.message);
    process.exit(1);
  }
});
server.listen({ host: "127.0.0.1", port: Number(port) }, () => {
  try {
    fs.writeFileSync(lockPath, process.pid + " " + token + "\n");
    reply("READY " + process.pid);
  } catch (error) {
    console.error(error.message);
    server.close(() => process.exit(1));
  }
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\n")) !== -1) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    const match = line.match(/^SAVE ([A-Za-z0-9+\/=]+)$/);
    if (match) save(match[1]);
  }
});
process.stdin.on("end", () => server.close(() => process.exit(0)));
`;

interface RegistryLock {
  process: ChildProcess;
  closed: boolean;
  pendingSave?: { resolve: () => void; reject: (error: Error) => void };
}
let registryLock: RegistryLock | undefined;

export function loadRegistry(): GroveRegistry {
  fs.mkdirSync(GROVE_DIR, { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { projects: {} };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
}

/** Save through the process that owns the local loopback lock, immediately before rename. */
export async function saveRegistry(registry: GroveRegistry): Promise<void> {
  const lock = registryLock;
  if (!lock || lock.closed || !lock.process.stdin?.writable) {
    throw new Error("registry save requires ownership of the registry lock");
  }
  if (lock.pendingSave) {
    throw new Error("registry save already in progress");
  }

  const contents = JSON.stringify(registry, null, 2) + "\n";
  await new Promise<void>((resolve, reject) => {
    lock.pendingSave = { resolve, reject };
    lock.process.stdin!.write(`SAVE ${Buffer.from(contents).toString("base64")}\n`, (error) => {
      if (!error) return;
      rejectPendingSave(lock, error);
    });
  });
}

/** Serialize registry read-modify-write operations across Grove processes. */
export async function withRegistryLock<T>(operation: (registry: GroveRegistry) => T | Promise<T>): Promise<T> {
  const lock = await acquireRegistryLock();
  registryLock = lock;
  try {
    return await operation(loadRegistry());
  } finally {
    registryLock = undefined;
    await releaseRegistryLock(lock);
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
    try {
      return await startLockHelper(randomUUID(), deadline - Date.now());
    } catch (error) {
      if ((error as Error).message !== "registry lock busy" || Date.now() >= deadline) {
        if ((error as Error).message === "registry lock busy") {
          throw new Error(`registry lock is held at ${REGISTRY_LOCK_PATH} by pid ${readLockHolder()}`);
        }
        throw error;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 500);
    }
  }
}

function startLockHelper(token: string, timeout: number): Promise<RegistryLock> {
  return new Promise((resolve, reject) => {
    const helper = spawn(process.execPath, ["-e", LOCK_HELPER, REGISTRY_PATH, REGISTRY_LOCK_PATH, token, String(LOCK_PORT)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    let lock: RegistryLock | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      helper.kill();
      reject(new Error("registry lock busy"));
    }, Math.max(1, timeout));

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const resolveSave = (line: string) => {
      const pending = lock?.pendingSave;
      if (!pending) return;
      lock!.pendingSave = undefined;
      if (line === "OK") pending.resolve();
      else pending.reject(new Error(`registry save failed: ${line.slice("ERROR ".length)}`));
    };
    helper.stdin!.on("error", (error) => {
      if (!lock) {
        fail(error);
        return;
      }
      lock.closed = true;
      rejectPendingSave(lock, error);
      helper.kill();
    });

    helper.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      let newline: number;
      while ((newline = output.indexOf("\n")) !== -1) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        const ready = line.match(/^READY (\d+)$/);
        if (!lock && ready) {
          lock = { process: helper, closed: false };
          settled = true;
          clearTimeout(timer);
          resolve(lock);
        } else if (line === "BUSY") {
          helper.kill();
          fail(new Error("registry lock busy"));
        } else {
          resolveSave(line);
        }
      }
    });
    helper.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    helper.once("error", (error) => fail(error));
    helper.once("exit", (code, signal) => {
      if (lock) lock.closed = true;
      if (lock) rejectPendingSave(lock, new Error("registry save requires ownership of the registry lock"));
      if (!settled) {
        fail(new Error(`registry lock helper exited (${signal ?? code ?? "unknown"}): ${stderr.trim()}`));
      }
    });
  });
}

async function releaseRegistryLock(lock: RegistryLock): Promise<void> {
  rejectPendingSave(lock, new Error("registry lock released before save completed"));
  if (lock.closed) return;
  await new Promise<void>((resolve) => {
    lock.process.once("exit", () => resolve());
    lock.process.stdin?.end();
    if (lock.closed) resolve();
  });
}

function rejectPendingSave(lock: RegistryLock, error: Error): void {
  const pending = lock.pendingSave;
  if (!pending) return;
  lock.pendingSave = undefined;
  pending.reject(error);
}

function readLockHolder(): string {
  try {
    const contents = fs.readFileSync(REGISTRY_LOCK_PATH, "utf-8");
    return contents.match(/^(\d+) [0-9a-f-]+\n$/)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import { execFileSync, fork, type ChildProcess, type Serializable } from "child_process";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import type { GrovePendingOperation } from "./types.js";

export interface PendingOperationWorker {
  identity: Pick<GrovePendingOperation, "pid" | "processGroup" | "startedAt">;
  run(message: Serializable): Promise<void>;
  abort(): void;
}

/** Start a detached worker that cannot mutate an instance until its parent sends work. */
export function startPendingOperationWorker(): PendingOperationWorker {
  const currentFile = fileURLToPath(import.meta.url);
  const source = currentFile.endsWith(".ts");
  const workerFile = path.join(path.dirname(currentFile), `operation-worker.${source ? "ts" : "js"}`);
  const child = fork(workerFile, [], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    execArgv: source ? ["--import", createRequire(import.meta.url).resolve("tsx")] : undefined,
  });
  const identity = {
    pid: child.pid!,
    processGroup: child.pid!,
    startedAt: processStartIdentity(child.pid!),
  };
  return {
    identity,
    run: (message) => runWorker(child, message),
    abort: () => terminateProcessGroup(identity.processGroup),
  };
}

/** A pending operation is live while its detached worker's process group has a member. */
export function isPendingOperationActive(operation: GrovePendingOperation | undefined): boolean {
  if (!operation) return false;
  if (operation.processGroup !== undefined) {
    if (!isProcessGroupAlive(operation.processGroup)) return false;
    if (operation.startedAt && isProcessAlive(operation.pid)) {
      return processStartIdentity(operation.pid) === operation.startedAt;
    }
    return true;
  }
  return isProcessAlive(operation.pid);
}

function runWorker(child: ChildProcess, message: Serializable): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`operation worker ${child.pid} exited ${signal ? `from ${signal}` : `with status ${code}`}`));
    });
    child.send(message, (error) => {
      if (error) reject(error);
    });
  });
}

function terminateProcessGroup(processGroup: number): void {
  try {
    process.kill(-processGroup, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isProcessGroupAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processStartIdentity(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

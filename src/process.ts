import { execSync } from "child_process";
import { checkPort } from "./ports.js";

/** Find PIDs listening on a given port. */
export function findPidsOnPort(port: number): number[] {
  try {
    const out = execSync(`lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
    if (!out) return [];
    return out
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));
  } catch {
    return [];
  }
}

/** Find all PIDs whose command line contains the given path. */
export function findPidsByPath(instancePath: string): number[] {
  try {
    const out = execSync(`pgrep -f "${instancePath}" 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
    if (!out) return [];
    return out
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));
  } catch {
    return [];
  }
}

function killPid(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function forceKillPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kill a set of PIDs. SIGTERM, wait up to 3s, then SIGKILL survivors.
 * Returns the count of PIDs that were signaled.
 */
export async function killPids(pids: number[]): Promise<number> {
  if (!pids.length) return 0;

  const unique = [...new Set(pids)];
  const killed: number[] = [];

  for (const pid of unique) {
    if (killPid(pid)) killed.push(pid);
  }

  if (!killed.length) return 0;

  // Wait up to 3s for graceful shutdown
  for (let i = 0; i < 6; i++) {
    if (killed.every((p) => !isAlive(p))) return killed.length;
    await sleep(500);
  }

  // SIGKILL survivors
  for (const pid of killed) {
    if (isAlive(pid)) forceKillPid(pid);
  }

  await sleep(1000);
  return killed.length;
}

/**
 * Stop all services for an instance by:
 * 1. Killing processes on every computed port
 * 2. Killing any remaining processes rooted in the instance directory
 * 3. Verifying all ports are free
 */
export async function stopInstanceServices(
  instancePath: string,
  ports: Record<string, number>,
  output: (message: string) => void = console.log,
): Promise<{ killed: number; portsFreed: boolean }> {
  let totalKilled = 0;

  // Phase 1: Kill processes on each port
  const portEntries = Object.entries(ports);
  for (const [svc, port] of portEntries) {
    const pids = findPidsOnPort(port);
    if (pids.length) {
      output(`  Killing ${svc} on :${port} (${pids.length} pid${pids.length > 1 ? "s" : ""})...`);
      totalKilled += await killPids(pids);
    }
  }

  // Phase 2: Kill any remaining processes by path
  const pathPids = findPidsByPath(instancePath);
  if (pathPids.length) {
    output(`  Killing ${pathPids.length} remaining process${pathPids.length > 1 ? "es" : ""} in ${instancePath}...`);
    totalKilled += await killPids(pathPids);
  }

  // Phase 3: Verify ports are free
  let allFree = true;
  for (const [svc, port] of portEntries) {
    const stillUp = await checkPort(port);
    if (stillUp) {
      const remainingPids = findPidsOnPort(port);
      output(
        `  \x1b[31m✗\x1b[0m Port ${port} (${svc}) still in use${remainingPids.length ? ` by PID ${remainingPids.join(", ")}` : ""}`,
      );
      allFree = false;
    }
  }

  // Phase 4: Final check — any path-matched processes still alive?
  const survivors = findPidsByPath(instancePath);
  if (survivors.length) {
    output(`  \x1b[33m⚠\x1b[0m ${survivors.length} process${survivors.length > 1 ? "es" : ""} still running (force killing)...`);
    for (const pid of survivors) {
      forceKillPid(pid);
    }
    await sleep(1000);
    totalKilled += survivors.length;

    const finalSurvivors = findPidsByPath(instancePath);
    if (finalSurvivors.length) {
      output(`  \x1b[31m✗\x1b[0m ${finalSurvivors.length} unkillable process${finalSurvivors.length > 1 ? "es" : ""} remain: ${finalSurvivors.join(", ")}`);
      allFree = false;
    }
  }

  return { killed: totalKilled, portsFreed: allFree };
}

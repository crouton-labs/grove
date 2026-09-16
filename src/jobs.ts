import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { GROVE_DIR } from "./registry.js";

/**
 * Background jobs.
 *
 * A long verb — release, rollout, apply — takes minutes, and running it in the
 * foreground pins a terminal or the whole `grove ui` screen to it for that
 * whole time. A job is the same verb run by a detached copy of grove whose
 * output lands in a file, so the window that started it is free immediately and
 * anything can watch, or cancel, the work afterwards.
 *
 * The record and the log are plain files under ~/.grove/jobs, which is what
 * lets a watcher be a different process from the one that started the job.
 */

export const JOBS_DIR = path.join(GROVE_DIR, "jobs");

/** Finished jobs kept on disk; older records and their logs are pruned. */
const KEEP_FINISHED = 40;

/** How often a follower re-reads the log and the record. */
const FOLLOW_INTERVAL_MS = 250;

export interface GroveJob {
  id: string;
  /** The verb and target as a person would say it: `release northlight/3`. */
  label: string;
  /** Grove's own argv for the run, without the program name. */
  args: string[];
  cwd: string;
  startedAt: string;
  pid?: number;
  endedAt?: string;
  exitCode?: number;
  /** Set when someone asked the job to stop, so its end reads as cancelled rather than lost. */
  cancelledAt?: string;
}

/**
 * `lost` is a job whose process is gone without ever recording an exit: it was
 * killed outright, or the machine went down mid-run. Its work may be half done,
 * which is exactly the case grove's own pending-operation state already covers.
 */
export type JobState = "running" | "done" | "failed" | "cancelled" | "lost";

export function jobRecordPath(id: string): string {
  return path.join(JOBS_DIR, `${id}.json`);
}

export function jobLogPath(id: string): string {
  return path.join(JOBS_DIR, `${id}.log`);
}

export function readJob(id: string): GroveJob | null {
  try {
    return JSON.parse(fs.readFileSync(jobRecordPath(id), "utf-8")) as GroveJob;
  } catch {
    return null;
  }
}

function writeJob(job: GroveJob): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const temporary = `${jobRecordPath(job.id)}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf-8");
  fs.renameSync(temporary, jobRecordPath(job.id));
}

/**
 * Merge fields into a record without discarding what another process wrote.
 * The starting process records the pid after the spawn returns, and a very
 * short job can record its own exit first; a blind overwrite in either
 * direction loses the other's field.
 */
function updateJob(id: string, changes: Partial<GroveJob>): GroveJob | null {
  const current = readJob(id);
  if (!current) return null;
  const merged = { ...current, ...changes };
  writeJob(merged);
  return merged;
}

export function listJobs(): GroveJob[] {
  let names: string[];
  try {
    names = fs.readdirSync(JOBS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJob(name.slice(0, -".json".length)))
    .filter((job): job is GroveJob => job !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists and belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function jobState(job: GroveJob): JobState {
  if (job.endedAt !== undefined) return job.exitCode === 0 ? "done" : "failed";
  if (job.pid !== undefined && !processAlive(job.pid)) {
    // An interrupt terminates the process without running its exit hook, so a
    // cancelled job records no code of its own and is only distinguishable
    // from a killed one by the cancel that asked for it.
    return job.cancelledAt === undefined ? "lost" : "cancelled";
  }
  return "running";
}

export function runningJobs(): GroveJob[] {
  return listJobs().filter((job) => jobState(job) === "running");
}

/**
 * Resolve what a person typed into one job: an id, a unique id prefix, or a
 * target ref such as `northlight/3`, which selects that target's newest job.
 * Ambiguity is named rather than guessed at.
 */
export function resolveJob(ref: string): GroveJob {
  const jobs = listJobs();
  if (jobs.length === 0) throw new Error("no jobs have been recorded yet");
  const exact = jobs.find((job) => job.id === ref);
  if (exact) return exact;
  const byPrefix = jobs.filter((job) => job.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) {
    throw new Error(`job id "${ref}" is ambiguous: ${byPrefix.map((job) => job.id).join(", ")}`);
  }
  // Newest first, so the first label match is the most recent run for that ref.
  const byLabel = jobs.find((job) => job.label.split(" ").includes(ref));
  if (byLabel) return byLabel;
  throw new Error(`no job matches "${ref}". Run: grove jobs`);
}

/** The most recent job, for `grove logs` with nothing named. */
export function latestJob(): GroveJob {
  const [job] = listJobs();
  if (!job) throw new Error("no jobs have been recorded yet");
  return job;
}

function newJobId(): string {
  for (;;) {
    const id = randomBytes(4).toString("hex").slice(0, 6);
    if (!fs.existsSync(jobRecordPath(id))) return id;
  }
}

/** Delete the oldest finished records and their logs, keeping the newest KEEP_FINISHED. */
export function pruneJobs(): void {
  const finished = listJobs().filter((job) => jobState(job) !== "running");
  for (const job of finished.slice(KEEP_FINISHED)) {
    fs.rmSync(jobRecordPath(job.id), { force: true });
    fs.rmSync(jobLogPath(job.id), { force: true });
  }
}

/**
 * Run grove's own CLI detached, with its output appended to the job's log.
 *
 * The child is re-launched through this process's own interpreter and script
 * path, so a job started from `pnpm dev` runs the source and a job started from
 * the installed bin runs the build. GROVE_JOB_ID tells that child to record its
 * own exit; see `recordJobExitOnExit`.
 */
export function startDetachedJob(args: string[], label: string): GroveJob {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  pruneJobs();

  const id = newJobId();
  const job: GroveJob = {
    id,
    label,
    args,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
  writeJob(job);

  const log = fs.openSync(jobLogPath(id), "a");
  try {
    fs.writeSync(log, `$ grove ${args.join(" ")}\n`);
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
      cwd: job.cwd,
      detached: true,
      stdio: ["ignore", log, log],
      // FORCE_COLOR off: the log is read back as plain text by `grove logs` and
      // by the ui's pane, neither of which wants escape sequences in it.
      env: { ...process.env, GROVE_JOB_ID: id, FORCE_COLOR: "0" },
    });
    child.unref();
    return updateJob(id, { pid: child.pid }) ?? { ...job, pid: child.pid };
  } finally {
    fs.closeSync(log);
  }
}

/**
 * In a job's own process, record the exit code when it ends. Registered from
 * the CLI entry point, because grove's commands set process.exitCode rather
 * than throwing, so the code is only final at exit.
 */
export function recordJobExitOnExit(id: string): void {
  process.on("exit", (code) => {
    updateJob(id, { endedAt: new Date().toISOString(), exitCode: code });
  });
}

/** Ask a running job to stop, the same way Ctrl-C would. */
export function cancelJob(job: GroveJob): void {
  if (job.pid === undefined) throw new Error(`job ${job.id} never recorded a pid`);
  if (jobState(job) !== "running") throw new Error(`job ${job.id} is not running`);
  // The child is detached, so it leads its own process group: a negative pid
  // reaches the verb's own children too, which is what Ctrl-C does in a
  // terminal and what a half-finished install or docker build needs.
  updateJob(job.id, { cancelledAt: new Date().toISOString() });
  try {
    process.kill(-job.pid, "SIGINT");
  } catch {
    process.kill(job.pid, "SIGINT");
  }
}

export interface JobFollow {
  /** Resolves with the job's exit code; 1 for a job that was lost. */
  exit: Promise<number>;
  /** Stop following. The job keeps running. */
  interrupt: () => void;
}

/**
 * Stream a job's log line by line and resolve once it ends.
 *
 * Polling rather than watching: the writer is a different process, the log can
 * be rotated away by a prune, and `fs.watch` reports neither of those the same
 * way on every platform.
 */
export function followJob(job: GroveJob, onLine: (line: string) => void): JobFollow {
  const logPath = jobLogPath(job.id);
  let offset = 0;
  let pending = "";
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const drain = () => {
    let size: number;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const handle = fs.openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      const read = fs.readSync(handle, buffer, 0, buffer.length, offset);
      offset += read;
      pending += buffer.subarray(0, read).toString("utf-8");
    } finally {
      fs.closeSync(handle);
    }
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };

  const exit = new Promise<number>((resolve) => {
    const poll = () => {
      if (stopped) return;
      drain();
      const current = readJob(job.id);
      const state = current ? jobState(current) : "lost";
      if (state === "running") return;
      stopped = true;
      if (timer) clearInterval(timer);
      drain();
      if (pending) onLine(pending);
      if (state === "cancelled") {
        onLine(`job ${job.id} was cancelled — grove list names the re-run that finishes it`);
        return resolve(1);
      }
      if (state === "lost") {
        onLine(`job ${job.id} ended without recording an exit — check the target's state with: grove list`);
        return resolve(1);
      }
      resolve(current?.exitCode ?? 1);
    };
    timer = setInterval(poll, FOLLOW_INTERVAL_MS);
    poll();
  });

  return {
    exit,
    interrupt: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

/** Wall time in a compact form: 9s, 2m14s, 1h04m. */
export function jobElapsed(job: GroveJob): string {
  // A cancelled job never records an exit, so its cancel time is where its
  // clock stops; without that it would keep counting up forever.
  const ended = job.endedAt ?? (jobState(job) === "cancelled" ? job.cancelledAt : undefined);
  const end = ended ? Date.parse(ended) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

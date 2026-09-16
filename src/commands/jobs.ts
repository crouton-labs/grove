import fs from "fs";
import {
  cancelJob,
  followJob,
  jobElapsed,
  jobLogPath,
  jobState,
  latestJob,
  listJobs,
  resolveJob,
  type GroveJob,
  type JobState,
} from "../jobs.js";

const STATE_COLOR: Record<JobState, string> = {
  running: "\x1b[33m",
  done: "\x1b[32m",
  failed: "\x1b[31m",
  cancelled: "\x1b[33m",
  lost: "\x1b[31m",
};

/** The longest state, `cancelled`, plus the gap before ELAPSED. */
const STATE_WIDTH = 10;

function paint(state: JobState): string {
  if (!process.stdout.isTTY) return state.padEnd(STATE_WIDTH);
  return `${STATE_COLOR[state]}${state.padEnd(STATE_WIDTH)}\x1b[0m`;
}

function startedClock(job: GroveJob): string {
  return new Date(job.startedAt).toTimeString().slice(0, 5);
}

/** List recorded background jobs, newest first. */
export function jobs(): void {
  try {
    const all = listJobs();
    if (all.length === 0) {
      console.log("No background jobs. Start one by adding --detach to a long verb, for example:");
      console.log("  grove release northlight/3 --detach");
      return;
    }
    console.log(`ID      ${"STATE".padEnd(STATE_WIDTH)}${"ELAPSED".padEnd(9)}START  COMMAND`);
    for (const job of all) {
      const state = jobState(job);
      console.log(`${job.id}  ${paint(state)}${jobElapsed(job).padEnd(9)}${startedClock(job)}  ${job.label}`);
    }
    console.log("\nWatch one with: grove logs <id> -f   ·   stop one with: grove cancel <id>");
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

interface LogsOptions {
  follow?: boolean;
}

/** Print a job's log, optionally following it until the job ends. */
export async function logs(ref: string | undefined, options: LogsOptions): Promise<void> {
  try {
    const job = ref === undefined ? latestJob() : resolveJob(ref);
    const state = jobState(job);
    if (!options.follow || state !== "running") {
      const existing = fs.existsSync(jobLogPath(job.id))
        ? fs.readFileSync(jobLogPath(job.id), "utf-8")
        : "";
      process.stdout.write(existing);
      if (state === "running") {
        console.log(`\n${job.id} is still running (${jobElapsed(job)}). Follow it with: grove logs ${job.id} -f`);
      } else if (state === "cancelled") {
        console.log(`\n${job.id} was cancelled after ${jobElapsed(job)}. grove list names the re-run that finishes it.`);
      } else if (state === "lost") {
        console.log(`\n${job.id} ended without recording an exit.`);
      } else {
        console.log(`\n${job.id} exited ${job.exitCode} after ${jobElapsed(job)}.`);
      }
      process.exitCode = state === "done" ? 0 : 1;
      return;
    }
    // Following never interrupts the job: Ctrl-C here detaches this watcher,
    // which is the whole point of a job having been detached in the first place.
    const follow = followJob(job, (line) => console.log(line));
    const onSigint = () => {
      follow.interrupt();
      console.log(`\nStopped watching. ${job.id} is still running — stop it with: grove cancel ${job.id}`);
      process.exit(0);
    };
    process.on("SIGINT", onSigint);
    const code = await follow.exit;
    process.off("SIGINT", onSigint);
    console.log(`\n${job.id} exited ${code} after ${jobElapsed(resolveJob(job.id))}.`);
    process.exitCode = code;
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

/** Ask a running job to stop. */
export function cancel(ref: string): void {
  try {
    const job = resolveJob(ref);
    cancelJob(job);
    console.log(`Asked ${job.id} (${job.label}) to stop.`);
    console.log("A verb interrupted partway leaves its reservation in place; grove list names the re-run that finishes it.");
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

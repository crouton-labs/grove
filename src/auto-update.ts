import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { GROVE_DIR } from "./registry.js";

const PKG = "@crouton-kit/grove";
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // attempt at most once every 3h
const STAMP = path.join(GROVE_DIR, ".last-update-check");

/**
 * Best-effort, non-blocking self-update. Called once at CLI startup.
 *
 * Throttled to one attempt per CHECK_INTERVAL_MS. When due, it detaches a
 * silent `npm install -g <pkg>@latest` and returns immediately — the running
 * command never waits on the network or npm, and nothing is printed (grove's
 * stdout is parsed by callers, e.g. /grove:plant, so it must stay clean). npm
 * itself decides whether anything is newer; when already current it's a no-op.
 *
 * Any update swaps the installed files on disk and takes effect on the *next*
 * invocation — safe mid-run because Node loads all modules into memory at start.
 *
 * Opt out with GROVE_NO_UPDATE=1 (also skipped under CI).
 */
export function maybeScheduleUpdate(): void {
  if (process.env.GROVE_NO_UPDATE === "1" || process.env.CI) return;
  if (!dueForCheck()) return;
  touchStamp(); // stamp before spawning so a failed attempt still throttles

  try {
    const child = spawn("npm", ["install", "-g", `${PKG}@latest`], {
      detached: true, // own process group — outlives this grove process
      stdio: "ignore", // emit nothing into the caller's output
    });
    child.unref(); // don't keep grove's event loop alive for it
  } catch (err) {
    ignore(err); // never let self-update break the command the user ran
  }
}

function dueForCheck(): boolean {
  try {
    return Date.now() - fs.statSync(STAMP).mtimeMs > CHECK_INTERVAL_MS;
  } catch {
    return true; // no stamp yet → first run
  }
}

function touchStamp(): void {
  try {
    fs.mkdirSync(GROVE_DIR, { recursive: true });
    fs.writeFileSync(STAMP, new Date().toISOString());
  } catch (err) {
    ignore(err); // worst case we just try again next run
  }
}

/** Deliberately swallow a non-critical failure — self-update is best-effort. */
function ignore(err?: unknown): void {
  void err;
}

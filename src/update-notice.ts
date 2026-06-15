import fs from "fs";
import path from "path";
import https from "https";
import { GROVE_DIR } from "./registry.js";

const PKG = "@crouton-kit/grove";
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // check at most once every 3h
const FETCH_TIMEOUT_MS = 2500;
const STAMP = path.join(GROVE_DIR, ".last-update-check");

/**
 * Notify — never auto-install — when a newer grove has been published.
 *
 * Throttled to one registry check per CHECK_INTERVAL_MS. The notice is written
 * to STDERR so stdout stays clean for callers that parse it (e.g. /grove:plant
 * reads a `--- grove-output ---` JSON block from stdout). We deliberately don't
 * run the install ourselves: grove may be installed via npm, pnpm, yarn or bun,
 * and guessing wrong risks a conflicting parallel install. The caller (a human,
 * or Claude, which can inspect the environment) runs the right command.
 *
 * Best-effort: every failure path (offline, throttle file, parse) is swallowed.
 * Disable with GROVE_NO_UPDATE=1 (also skipped under CI).
 */
export async function noticeIfUpdateAvailable(currentVersion: string): Promise<void> {
  if (process.env.GROVE_NO_UPDATE === "1" || process.env.CI) return;
  if (!dueForCheck()) return;
  touchStamp(); // stamp before the network call so a failure still throttles

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    ignore(err); // offline / registry error → just skip the notice this run
    return;
  }
  if (!isNewer(latest, currentVersion)) return;

  process.stderr.write(
    `\n[grove] update available: ${currentVersion} → ${latest}\n` +
      `[grove] update your global install to match how grove was installed, e.g.\n` +
      `        npm i -g ${PKG}@latest   (or: pnpm add -g / bun add -g / yarn global add ${PKG}@latest)\n\n`,
  );
}

function dueForCheck(): boolean {
  try {
    return Date.now() - fs.statSync(STAMP).mtimeMs > CHECK_INTERVAL_MS;
  } catch (err) {
    ignore(err); // no stamp yet (first run) → treat as due
    return true;
  }
}

function touchStamp(): void {
  try {
    fs.mkdirSync(GROVE_DIR, { recursive: true });
    fs.writeFileSync(STAMP, new Date().toISOString());
  } catch (err) {
    ignore(err); // worst case we just check again next run
  }
}

function fetchLatestVersion(): Promise<string> {
  const url = `https://registry.npmjs.org/-/package/${PKG.replace("/", "%2f")}/dist-tags`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`registry status ${res.statusCode}`));
        return;
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).latest as string);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("registry timeout")));
    req.on("error", reject);
  });
}

/** Minimal x.y.z compare (CI ships plain patch bumps; prerelease suffixes ignored). */
function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split(".").map((p) => parseInt(p, 10) || 0);
  const b = current.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

/** Deliberately swallow a non-critical failure — the update notice is best-effort. */
function ignore(err?: unknown): void {
  void err;
}

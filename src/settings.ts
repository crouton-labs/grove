import fs from "fs";
import path from "path";
import { GROVE_DIR } from "./registry.js";

export interface GroveSettings {
  version: 1;
  /** After `grove stop` succeeds, kill the target's tmux session. */
  killTmuxSessionOnStop: boolean;
}

const DEFAULTS: GroveSettings = { version: 1, killTmuxSessionOnStop: false };

export const SETTINGS_PATH = path.join(GROVE_DIR, "settings.json");

export const SETTINGS_EXAMPLE = `{ "version": 1, "killTmuxSessionOnStop": false }`;

/**
 * Read `~/.grove/settings.json`. A missing file is the defaults; a malformed one
 * is a refusal naming the file and the key. Nothing in grove writes this file.
 */
export function loadSettings(): GroveSettings {
  if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULTS };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch (error) {
    throw new Error(`${SETTINGS_PATH} is not valid JSON: ${(error as Error).message}. Expected ${SETTINGS_EXAMPLE}`);
  }
  return validateSettings(raw);
}

export function validateSettings(raw: unknown): GroveSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${SETTINGS_PATH} must be an object. Expected ${SETTINGS_EXAMPLE}`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`${SETTINGS_PATH} version must be 1 (got ${JSON.stringify(obj.version)}). Expected ${SETTINGS_EXAMPLE}`);
  }
  const settings: GroveSettings = { ...DEFAULTS };
  for (const [key, value] of Object.entries(obj)) {
    if (key === "version") continue;
    if (key === "killTmuxSessionOnStop") {
      if (typeof value !== "boolean") {
        throw new Error(`${SETTINGS_PATH} killTmuxSessionOnStop must be a boolean (got ${JSON.stringify(value)})`);
      }
      settings.killTmuxSessionOnStop = value;
      continue;
    }
    throw new Error(`${SETTINGS_PATH} has unknown key "${key}" — allowed keys: version, killTmuxSessionOnStop`);
  }
  return settings;
}

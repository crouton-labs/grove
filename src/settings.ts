import fs from "fs";
import os from "os";
import path from "path";
import { GROVE_DIR } from "./registry.js";

export interface GroveSettings {
  version: 1;
  /** Per-machine handle for globally unique project identities. */
  machine: string;
  /** After `grove stop` succeeds, kill the target's tmux session. */
  killTmuxSessionOnStop: boolean;
  /**
   * The command `grove ui` runs for its `O` key, with `${owner}` replaced by the
   * row's `owner` label value. Empty means the key is not configured; grove
   * substitutes the label into whatever the machine names here and reads nothing
   * else about it.
   */
  openOwnerCommand: string[];
}

const MACHINE_PATTERN = /^[a-z0-9-]{1,16}$/;
const DEFAULT_MACHINE = os.hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16);
const DEFAULTS: GroveSettings = { version: 1, machine: DEFAULT_MACHINE, killTmuxSessionOnStop: false, openOwnerCommand: [] };

export const SETTINGS_PATH = path.join(GROVE_DIR, "settings.json");

export const SETTINGS_EXAMPLE = `{ "version": 1, "machine": "my-machine", "killTmuxSessionOnStop": false, "openOwnerCommand": ["my-tool", "open", "\${owner}"] }`;

/**
 * Read `~/.grove/settings.json`. A missing file is the defaults; a malformed one
 * is a refusal naming the file and the key. Nothing in grove writes this file.
 */
export function loadSettings(): GroveSettings {
  if (!fs.existsSync(SETTINGS_PATH)) {
    if (!MACHINE_PATTERN.test(DEFAULT_MACHINE)) {
      throw new Error(`could not derive a machine handle from hostname ${JSON.stringify(os.hostname())}; set machine in ${SETTINGS_PATH} to a string matching ${MACHINE_PATTERN}`);
    }
    return { ...DEFAULTS, openOwnerCommand: [...DEFAULTS.openOwnerCommand] };
  }
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
  const settings: GroveSettings = { ...DEFAULTS, openOwnerCommand: [...DEFAULTS.openOwnerCommand] };
  for (const [key, value] of Object.entries(obj)) {
    if (key === "version") continue;
    if (key === "machine") {
      if (typeof value !== "string" || !MACHINE_PATTERN.test(value)) {
        throw new Error(`${SETTINGS_PATH} machine must match ${MACHINE_PATTERN} (got ${JSON.stringify(value)})`);
      }
      settings.machine = value;
      continue;
    }
    if (key === "killTmuxSessionOnStop") {
      if (typeof value !== "boolean") {
        throw new Error(`${SETTINGS_PATH} killTmuxSessionOnStop must be a boolean (got ${JSON.stringify(value)})`);
      }
      settings.killTmuxSessionOnStop = value;
      continue;
    }
    if (key === "openOwnerCommand") {
      if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || part.length === 0)) {
        throw new Error(`${SETTINGS_PATH} openOwnerCommand must be a non-empty array of non-empty strings (got ${JSON.stringify(value)})`);
      }
      settings.openOwnerCommand = value as string[];
      continue;
    }
    throw new Error(`${SETTINGS_PATH} has unknown key "${key}" — allowed keys: version, machine, killTmuxSessionOnStop, openOwnerCommand`);
  }
  if (!MACHINE_PATTERN.test(settings.machine)) {
    throw new Error(`could not derive a machine handle from hostname ${JSON.stringify(os.hostname())}; set machine in ${SETTINGS_PATH} to a string matching ${MACHINE_PATTERN}`);
  }
  return settings;
}

import path from "path";
import fs from "fs";
import { PortDef } from "./types.js";

export const GROVE_CONFIG_DIR = ".claude/grove";
export const GROVE_CONFIG_FILE = ".claude/grove/config.json";
export const GROVE_SETUP_FILE = ".claude/grove/setup.sh";

export interface GroveRepoConfig {
  version: number;
  name?: string;
  ports: Record<string, PortDef>;
  excludes?: string[];
  setupHandlesCopy?: boolean;
  teardownScript?: string;
}

export function loadRepoConfig(projectPath: string): GroveRepoConfig | null {
  const configPath = path.join(projectPath, GROVE_CONFIG_FILE);
  if (!fs.existsSync(configPath)) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return validateRepoConfig(raw);
}

export function validateRepoConfig(raw: unknown): GroveRepoConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("grove config must be an object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.version !== "number") {
    throw new Error("grove config must have a numeric version field");
  }
  if (obj.version !== 1) {
    throw new Error(`grove config version ${obj.version} is not supported (expected 1)`);
  }
  if (typeof obj.ports !== "object" || obj.ports === null) {
    throw new Error("grove config must have a ports object");
  }

  const ports: Record<string, PortDef> = {};
  for (const [key, val] of Object.entries(obj.ports as Record<string, unknown>)) {
    if (typeof val !== "object" || val === null) {
      throw new Error(`ports.${key} must be an object`);
    }
    const portObj = val as Record<string, unknown>;
    if (typeof portObj.base !== "number") {
      throw new Error(`ports.${key}.base must be a number`);
    }
    if (typeof portObj.offset !== "number") {
      throw new Error(`ports.${key}.offset must be a number`);
    }
    ports[key] = { base: portObj.base, offset: portObj.offset };
  }

  if (obj.name !== undefined && typeof obj.name !== "string") {
    throw new Error("grove config name must be a string");
  }
  if (obj.excludes !== undefined) {
    if (!Array.isArray(obj.excludes) || !obj.excludes.every((e) => typeof e === "string")) {
      throw new Error("grove config excludes must be a string array");
    }
  }
  if (obj.setupHandlesCopy !== undefined && typeof obj.setupHandlesCopy !== "boolean") {
    throw new Error("grove config setupHandlesCopy must be a boolean");
  }
  if (obj.teardownScript !== undefined && typeof obj.teardownScript !== "string") {
    throw new Error("grove config teardownScript must be a string");
  }

  return {
    version: obj.version,
    name: obj.name as string | undefined,
    ports,
    excludes: obj.excludes as string[] | undefined,
    setupHandlesCopy: obj.setupHandlesCopy as boolean | undefined,
    teardownScript: obj.teardownScript as string | undefined,
  };
}

export function hasSetupScript(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, GROVE_SETUP_FILE));
}

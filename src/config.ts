import path from "path";
import fs from "fs";
import { PortDef } from "./types.js";

export const GROVE_CONFIG_DIR = ".claude/grove";
export const GROVE_CONFIG_FILE = ".claude/grove/config.json";
export const GROVE_SETUP_FILE = ".claude/grove/setup.sh";

export interface RepoSpec {
  branch?: string;           // default: "main"
  recurseSubmodules?: boolean;
}

export interface CopyFromSourceSpec {
  from: string;              // relative path in source
  to?: string;               // relative path in target (defaults to `from`)
  patchPorts?: boolean;      // apply port substitution after copy
}

export interface InstallSpec {
  dir: string;               // relative directory in target
  cmds: string[];            // commands to run in that directory
}

export interface GroveRepoConfig {
  version: number;
  name?: string;
  ports: Record<string, PortDef>;
  excludes?: string[];
  teardownScript?: string;
  repos?: Record<string, RepoSpec>;
  copyFromSource?: CopyFromSourceSpec[];
  patchPortsIn?: string[];   // glob patterns relative to target
  install?: InstallSpec[];
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
  if (obj.teardownScript !== undefined && typeof obj.teardownScript !== "string") {
    throw new Error("grove config teardownScript must be a string");
  }

  // Validate repos
  let repos: Record<string, RepoSpec> | undefined;
  if (obj.repos !== undefined) {
    if (typeof obj.repos !== "object" || obj.repos === null) {
      throw new Error("grove config repos must be an object");
    }
    repos = {};
    for (const [key, val] of Object.entries(obj.repos as Record<string, unknown>)) {
      if (typeof val !== "object" || val === null) {
        throw new Error(`repos.${key} must be an object`);
      }
      const r = val as Record<string, unknown>;
      if (r.branch !== undefined && typeof r.branch !== "string") {
        throw new Error(`repos.${key}.branch must be a string`);
      }
      if (r.recurseSubmodules !== undefined && typeof r.recurseSubmodules !== "boolean") {
        throw new Error(`repos.${key}.recurseSubmodules must be a boolean`);
      }
      repos[key] = {
        branch: r.branch as string | undefined,
        recurseSubmodules: r.recurseSubmodules as boolean | undefined,
      };
    }
  }

  // Validate copyFromSource
  let copyFromSource: CopyFromSourceSpec[] | undefined;
  if (obj.copyFromSource !== undefined) {
    if (!Array.isArray(obj.copyFromSource)) {
      throw new Error("grove config copyFromSource must be an array");
    }
    copyFromSource = [];
    for (const [i, item] of (obj.copyFromSource as unknown[]).entries()) {
      if (typeof item !== "object" || item === null) {
        throw new Error(`copyFromSource[${i}] must be an object`);
      }
      const c = item as Record<string, unknown>;
      if (typeof c.from !== "string") {
        throw new Error(`copyFromSource[${i}].from must be a string`);
      }
      if (c.to !== undefined && typeof c.to !== "string") {
        throw new Error(`copyFromSource[${i}].to must be a string`);
      }
      if (c.patchPorts !== undefined && typeof c.patchPorts !== "boolean") {
        throw new Error(`copyFromSource[${i}].patchPorts must be a boolean`);
      }
      copyFromSource.push({
        from: c.from,
        to: c.to as string | undefined,
        patchPorts: c.patchPorts as boolean | undefined,
      });
    }
  }

  // Validate patchPortsIn
  if (obj.patchPortsIn !== undefined) {
    if (!Array.isArray(obj.patchPortsIn) || !obj.patchPortsIn.every((e) => typeof e === "string")) {
      throw new Error("grove config patchPortsIn must be a string array");
    }
  }

  // Validate install
  let install: InstallSpec[] | undefined;
  if (obj.install !== undefined) {
    if (!Array.isArray(obj.install)) {
      throw new Error("grove config install must be an array");
    }
    install = [];
    for (const [i, item] of (obj.install as unknown[]).entries()) {
      if (typeof item !== "object" || item === null) {
        throw new Error(`install[${i}] must be an object`);
      }
      const inst = item as Record<string, unknown>;
      if (typeof inst.dir !== "string") {
        throw new Error(`install[${i}].dir must be a string`);
      }
      if (!Array.isArray(inst.cmds) || !inst.cmds.every((c) => typeof c === "string")) {
        throw new Error(`install[${i}].cmds must be a string array`);
      }
      install.push({ dir: inst.dir, cmds: inst.cmds as string[] });
    }
  }

  return {
    version: obj.version,
    name: obj.name as string | undefined,
    ports,
    excludes: obj.excludes as string[] | undefined,
    teardownScript: obj.teardownScript as string | undefined,
    repos,
    copyFromSource,
    patchPortsIn: obj.patchPortsIn as string[] | undefined,
    install,
  };
}

export function hasSetupScript(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, GROVE_SETUP_FILE));
}

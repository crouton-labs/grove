import path from "path";
import fs from "fs";
import { PortDef } from "./types.js";

export const GROVE_CONFIG_FILE = ".grove/config.json";

// Shared help text: the minimal .grove/config.json a project needs before
// `grove register` / `grove dev` can drive it. Shown in `register -h` and
// when `dev` runs outside any registered project root.
export const GROVE_CONFIG_EXAMPLE = `A project declares itself in ${GROVE_CONFIG_FILE} at its root:

  {
    "version": 1,
    "devCommand": "scripts/dev.sh",
    "ports": {
      "app": { "base": 3000, "offset": 100 }
    }
  }

version      always 1.
devCommand   executable path relative to the project root; grove dispatches
             \`dev [args...]\` to it with cwd at the target root and env
             GROVE_SLOT, GROVE_SOURCE, GROVE_TARGET, GROVE_INSTANCE_NAME,
             GROVE_PORTS_JSON, and GROVE_PORT_<NAME> per port.
ports        one entry per service: an instance in slot N gets base + N * offset
             (the source checkout is slot 0, so it serves on base).
stateCommand optional executable path relative to the project root, answering
             \`reset\`, \`capture <dir>\`, \`restore <dir>\`, and \`fingerprint\`
             with the same env. It is what \`grove plant --from\`,
             \`grove snapshot\`, and \`grove restore\` drive.
secrets      optional [{ dir, cmds }] run in the target after files are copied
             and before ports are patched, so generated env files still get
             slot ports. A failing command aborts the plant.`;

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
  instancesDir?: string;     // parent dir for new instances, resolved relative to source (default: sibling of source)
  ports: Record<string, PortDef>;
  excludes?: string[];
  teardownScript?: string;
  devCommand?: string;        // target-root-relative executable for `grove dev`
  stateCommand?: string;      // target-root-relative executable answering the state verbs
  secrets?: InstallSpec[];    // commands that materialize env files, run before port patching
  repos?: Record<string, RepoSpec>;
  copyFromSource?: CopyFromSourceSpec[];
  patchPortsIn?: string[];   // glob patterns relative to target
  install?: InstallSpec[];
  aliases?: Record<string, string>; // aliasPrefix -> subdir relative to instance root
}

export function normalizeConfigFile(configFile = GROVE_CONFIG_FILE): string {
  if (!configFile.trim()) {
    throw new Error("grove config path must not be empty");
  }
  if (path.isAbsolute(configFile)) {
    throw new Error("grove config path must be relative to the project source");
  }
  const normalized = path.normalize(configFile);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("grove config path must stay inside the project source");
  }
  return normalized;
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function resolveProjectPath(projectPath: string, relativePath: string): string {
  const projectRoot = fs.realpathSync(projectPath);
  const candidate = path.resolve(projectRoot, relativePath);
  if (!fs.existsSync(candidate)) return candidate;

  const realCandidate = fs.realpathSync(candidate);
  if (!isWithinRoot(projectRoot, realCandidate)) {
    throw new Error("grove config and adjacent scripts must stay inside the project source");
  }
  return realCandidate;
}

export function resolveRepoConfigPath(projectPath: string, configFile = GROVE_CONFIG_FILE): string {
  return resolveProjectPath(projectPath, normalizeConfigFile(configFile));
}

/**
 * Resolve and validate a configured executable for a target root. `field` names
 * the config key in every error, so a failure says which one is wrong.
 */
export function resolveProjectExecutable(
  projectRoot: string,
  command: string,
  field: string,
): string {
  if (!command.trim() || path.isAbsolute(command)) {
    throw new Error(`grove config ${field} must be a non-empty path relative to the project root`);
  }

  const root = fs.realpathSync(projectRoot);
  const candidate = path.resolve(root, command);
  if (!isWithinRoot(root, candidate)) {
    throw new Error(`grove config ${field} must stay inside the project root`);
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`grove config ${field} does not exist: ${command}`);
  }

  const resolved = fs.realpathSync(candidate);
  if (!isWithinRoot(root, resolved)) {
    throw new Error(`grove config ${field} must stay inside the project root`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`grove config ${field} is not a regular file: ${command}`);
  }
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    throw new Error(`grove config ${field} is not executable: ${command}`);
  }
  return resolved;
}

/** Resolve and validate the configured development executable for a target root. */
export function resolveDevCommand(projectRoot: string, devCommand: string): string {
  return resolveProjectExecutable(projectRoot, devCommand, "devCommand");
}

/** Resolve and validate the configured state executable for a target root. */
export function resolveStateCommand(projectRoot: string, stateCommand: string): string {
  return resolveProjectExecutable(projectRoot, stateCommand, "stateCommand");
}

export function setupFileForConfig(configFile = GROVE_CONFIG_FILE): string {
  return path.join(path.dirname(normalizeConfigFile(configFile)), "setup.sh");
}

export function loadRepoConfig(
  projectPath: string,
  configFile = GROVE_CONFIG_FILE,
): GroveRepoConfig | null {
  const configPath = resolveRepoConfigPath(projectPath, configFile);
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
  if (obj.instancesDir !== undefined && typeof obj.instancesDir !== "string") {
    throw new Error("grove config instancesDir must be a string");
  }
  if (obj.excludes !== undefined) {
    if (!Array.isArray(obj.excludes) || !obj.excludes.every((e) => typeof e === "string")) {
      throw new Error("grove config excludes must be a string array");
    }
  }
  if (obj.teardownScript !== undefined && typeof obj.teardownScript !== "string") {
    throw new Error("grove config teardownScript must be a string");
  }
  for (const field of ["devCommand", "stateCommand"] as const) {
    const value = obj[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`grove config ${field} must be a string`);
    }
    const normalized = path.normalize(value);
    if (!value.trim() || path.isAbsolute(value) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`grove config ${field} must be a non-empty path relative to the project root`);
    }
  }
  // Validate aliases
  let aliases: Record<string, string> | undefined;
  if (obj.aliases !== undefined) {
    if (typeof obj.aliases !== "object" || obj.aliases === null) {
      throw new Error("grove config aliases must be an object");
    }
    aliases = {};
    for (const [key, val] of Object.entries(obj.aliases as Record<string, unknown>)) {
      if (typeof val !== "string") {
        throw new Error(`aliases.${key} must be a string (subdir relative to instance)`);
      }
      aliases[key] = val;
    }
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

  // Validate install and secrets — same shape, different phase
  const install = validateCommandSpecs(obj.install, "install");
  const secrets = validateCommandSpecs(obj.secrets, "secrets");

  return {
    version: obj.version,
    name: obj.name as string | undefined,
    instancesDir: obj.instancesDir as string | undefined,
    ports,
    excludes: obj.excludes as string[] | undefined,
    teardownScript: obj.teardownScript as string | undefined,
    devCommand: obj.devCommand as string | undefined,
    stateCommand: obj.stateCommand as string | undefined,
    repos,
    copyFromSource,
    patchPortsIn: obj.patchPortsIn as string[] | undefined,
    install,
    secrets,
    aliases,
  };
}

function validateCommandSpecs(raw: unknown, field: string): InstallSpec[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`grove config ${field} must be an array`);
  }
  const specs: InstallSpec[] = [];
  for (const [i, item] of (raw as unknown[]).entries()) {
    if (typeof item !== "object" || item === null) {
      throw new Error(`${field}[${i}] must be an object`);
    }
    const spec = item as Record<string, unknown>;
    if (typeof spec.dir !== "string") {
      throw new Error(`${field}[${i}].dir must be a string`);
    }
    if (!Array.isArray(spec.cmds) || !spec.cmds.every((c) => typeof c === "string")) {
      throw new Error(`${field}[${i}].cmds must be a string array`);
    }
    specs.push({ dir: spec.dir, cmds: spec.cmds as string[] });
  }
  return specs;
}

export function hasSetupScript(
  projectPath: string,
  configFile = GROVE_CONFIG_FILE,
): boolean {
  return fs.existsSync(resolveProjectPath(projectPath, setupFileForConfig(configFile)));
}

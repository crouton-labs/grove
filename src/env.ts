import fs from "fs";
import path from "path";
import { GROVE_DIR } from "./registry.js";
import type { GroveExecutionContext } from "./context.js";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SECRET_ENV_HELP = `Secret environment files

Every dispatched command merges these optional files, with the later scope winning:
  ~/.grove/env                     user scope, every project
  ~/.grove/env.d/<project>.env      project scope, every slot
  <target>/.grove/env               slot scope after the target exists

The legacy init script creates the target, so it receives only the user and
project scopes.

Lines are KEY=value. Blank lines and lines whose first non-whitespace character
is # are ignored. Values are literal after the first =, surrounding whitespace
is trimmed, and one matching pair of surrounding single or double quotes is
removed. There is no interpolation or export prefix. A malformed line, NUL byte,
duplicate key, or any GROVE_* key refuses and names its file and line; a duplicate
also names the earlier line. Grove's GROVE_* context values always override
inherited and secret-file values. Grove never creates, copies, or rewrites a slot
env file.`;

export interface EnvScopeFile {
  scope: "user" | "project" | "slot";
  path: string;
}

export interface EnvScopeReport extends EnvScopeFile {
  exists: boolean;
  keys: string[];
  error?: Error;
}

/** Files are ordered from broadest to nearest so later scopes override earlier ones. */
export function envScopeFiles(context: GroveExecutionContext): EnvScopeFile[] {
  const projectFile = path.resolve(GROVE_DIR, "env.d", `${context.projectName}.env`);
  const projectDir = path.resolve(GROVE_DIR, "env.d");
  if (path.dirname(projectFile) !== projectDir) {
    throw new Error(`project name ${JSON.stringify(context.projectName)} cannot name an env file in ${projectDir}`);
  }
  return [
    { scope: "user", path: path.join(GROVE_DIR, "env") },
    { scope: "project", path: projectFile },
    { scope: "slot", path: path.join(context.target, ".grove", "env") },
  ];
}

/** Validate user and project files before a new instance is reserved or copied. */
export function validateSharedEnv(projectName: string): void {
  const context: GroveExecutionContext = {
    projectName,
    source: "",
    target: "",
    slot: 0,
    instanceName: "",
    ports: {},
  };
  for (const file of envScopeFiles(context).slice(0, 2)) {
    if (fs.existsSync(file.path)) parseEnvFile(file.path);
  }
}

/** Parse and merge secret env files without ever exposing their values. */
export function loadScopedEnv(context: GroveExecutionContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const file of envScopeFiles(context)) {
    if (!fs.existsSync(file.path)) continue;
    Object.assign(env, parseEnvFile(file.path));
  }
  return env;
}

/** Inspect each scope separately so doctor can report every file and parse error. */
export function inspectScopedEnv(context: GroveExecutionContext): EnvScopeReport[] {
  return envScopeFiles(context).map((file) => {
    if (!fs.existsSync(file.path)) return { ...file, exists: false, keys: [] };
    try {
      return { ...file, exists: true, keys: Object.keys(parseEnvFile(file.path)) };
    } catch (error) {
      return { ...file, exists: true, keys: [], error: error as Error };
    }
  });
}

function parseEnvFile(filePath: string): NodeJS.ProcessEnv {
  let contents: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("not a regular file");
    contents = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(`${filePath}: ${(error as Error).message}`);
  }

  const env: NodeJS.ProcessEnv = {};
  const keyLines = new Map<string, number>();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) {
      throw parseError(filePath, lineNumber, "expected KEY=value");
    }

    const key = line.slice(0, separator).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      throw parseError(filePath, lineNumber, "key must use letters, digits, and underscores and cannot start with a digit");
    }
    if (key.startsWith("GROVE_")) {
      throw parseError(filePath, lineNumber, `${key} is reserved for Grove context`);
    }

    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.includes("\0")) {
      throw parseError(filePath, lineNumber, "NUL bytes are not allowed in values");
    }

    const firstLine = keyLines.get(key);
    if (firstLine !== undefined) {
      throw parseError(filePath, lineNumber, `duplicate key ${key}; first defined on line ${firstLine}`);
    }
    keyLines.set(key, lineNumber);
    env[key] = value;
  }
  return env;
}

function parseError(filePath: string, lineNumber: number, message: string): Error {
  return new Error(`${filePath}:${lineNumber}: ${message}`);
}

import fs from "fs";
import path from "path";
import { isDeepStrictEqual } from "node:util";
import { regenerateAliases } from "../aliases.js";
import {
  GROVE_CONFIG_FILE,
  isWithinRoot,
  loadRepoConfig,
  resolveDevCommand,
  resolveStateCommand,
} from "../config.js";
import { doctor } from "./doctor.js";
import { loadRegistry, saveRegistry } from "../registry.js";
import type { GroveProjectConfig } from "../types.js";

type MachineStatus = "registered" | "preserved" | "reconciled";

/** Validate a source repository's contract and register it on this machine. */
export async function setup(projectPath?: string): Promise<void> {
  try {
    const source = resolveSourcePath(projectPath);
    const registry = loadRegistry();
    refuseInstancePath(source, registry.projects);

    const config = loadRequiredConfig(source);
    validateConfiguredCommands(source, config.devCommand, config.stateCommand);

    const name = config.name || path.basename(source);
    const machine = reconcileRegistration(registry.projects, name, source, config);
    if (machine !== "preserved") saveRegistry(registry);
    regenerateAliases(registry);

    console.log(`Repository: ready — ${path.join(source, GROVE_CONFIG_FILE)}`);
    console.log(`Machine: ${machine} — ${name}`);
    console.log(`Next: grove plant ${name}`);
    console.log("Health:");
    await doctor(name);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function resolveSourcePath(projectPath?: string): string {
  const source = path.resolve(projectPath ?? process.cwd());
  if (!fs.existsSync(source)) {
    throw new Error(
      `source repository does not exist: ${source}\nRecovery: rerun \`grove setup\` with the source repository root.`,
    );
  }
  if (!fs.statSync(source).isDirectory()) {
    throw new Error(
      `source repository must be a directory: ${source}\nRecovery: rerun \`grove setup\` with the source repository root.`,
    );
  }
  return fs.realpathSync(source);
}

function refuseInstancePath(source: string, projects: Record<string, GroveProjectConfig>): void {
  for (const project of Object.values(projects)) {
    for (const instance of project.instances) {
      let instanceRoot: string;
      try {
        instanceRoot = fs.realpathSync(instance.path);
      } catch {
        continue;
      }
      if (!isWithinRoot(instanceRoot, source)) continue;
      throw new Error(
        `refusing to set up planted instance: ${source}\nUse its source repository root instead: ${project.source}\nNext: grove setup "${project.source}"`,
      );
    }
  }
}

function loadRequiredConfig(source: string) {
  try {
    const config = loadRepoConfig(source, GROVE_CONFIG_FILE);
    if (config) return config;
  } catch (error) {
    throw new Error(
      `repository contract is invalid: ${path.join(source, GROVE_CONFIG_FILE)}\n${(error as Error).message}\nRecovery: correct that file without having Grove generate it, then rerun \`grove setup "${source}"\`.\nRun \`grove setup -h\` for the repository config contract.`,
    );
  }
  throw new Error(
    `repository contract is missing: ${path.join(source, GROVE_CONFIG_FILE)}\nRecovery: add that file at the source repository root, then rerun \`grove setup "${source}"\`. Grove never creates repository lifecycle or config files.\nRun \`grove setup -h\` for the repository config contract.`,
  );
}

function validateConfiguredCommands(
  source: string,
  devCommand: string | undefined,
  stateCommand: string | undefined,
): void {
  try {
    if (devCommand) resolveDevCommand(source, devCommand);
    if (stateCommand) resolveStateCommand(source, stateCommand);
  } catch (error) {
    throw new Error(
      `repository contract is invalid: ${path.join(source, GROVE_CONFIG_FILE)}\n${(error as Error).message}\nRecovery: correct that file, then rerun \`grove setup "${source}"\`.\nRun \`grove setup -h\` for the repository config contract.`,
    );
  }
}

function reconcileRegistration(
  projects: Record<string, GroveProjectConfig>,
  name: string,
  source: string,
  config: NonNullable<ReturnType<typeof loadRepoConfig>>,
): MachineStatus {
  const expected = {
    source,
    configFile: GROVE_CONFIG_FILE,
    teardownScript: config.teardownScript,
    ports: config.ports,
    aliases: config.aliases,
  };
  const existing = projects[name];
  const duplicate = Object.entries(projects).find(
    ([registeredName, project]) => registeredName !== name && sameLocation(project.source, source),
  );
  if (duplicate) {
    throw new Error(
      `machine registration conflict: ${source} is already registered as "${duplicate[0]}", while its repository contract names it "${name}".\nRecovery: restore the existing registration name in ${GROVE_CONFIG_FILE} or remove the stale registration before rerunning \`grove setup\`. Setup will not create a second registration for one source.`,
    );
  }

  if (!existing) {
    projects[name] = {
      ...expected,
      instances: [],
    };
    return "registered";
  }

  if (!sameLocation(existing.source, source)) {
    throw registrationConflict(
      name,
      `source is ${existing.source}, not ${source}`,
      source,
    );
  }

  let configFile: string | undefined;
  try {
    configFile = existing.configFile === undefined ? undefined : path.normalize(existing.configFile);
  } catch {
    throw registrationConflict(name, `config path is invalid: ${existing.configFile}`, source);
  }
  if (configFile !== undefined && configFile !== GROVE_CONFIG_FILE) {
    throw registrationConflict(
      name,
      `config is ${existing.configFile}, not ${GROVE_CONFIG_FILE}`,
      source,
    );
  }

  const contractMatches =
    isDeepStrictEqual(existing.ports, expected.ports) &&
    existing.teardownScript === expected.teardownScript &&
    isDeepStrictEqual(existing.aliases, expected.aliases) &&
    existing.initScript === undefined;

  if (configFile === GROVE_CONFIG_FILE && contractMatches) return "preserved";

  if (configFile === undefined && contractMatches) {
    existing.configFile = GROVE_CONFIG_FILE;
    return "reconciled";
  }

  throw registrationConflict(
    name,
    "stored lifecycle settings differ from the repository contract",
    source,
  );
}

function sameLocation(left: string, right: string): boolean {
  if (path.resolve(left) === path.resolve(right)) return true;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function registrationConflict(name: string, detail: string, source: string): Error {
  return new Error(
    `machine registration conflict for "${name}": ${detail}\nRecovery: use the explicit update primitive to reconcile consequential changes: \`grove register "${source}" --update\`.`,
  );
}

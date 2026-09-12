import path from "path";
import fs from "fs";
import { saveRegistry, withRegistryLock } from "../registry.js";
import {
  GROVE_CONFIG_FILE,
  loadRepoConfig,
  normalizeConfigFile,
  resolveDevCommand,
  resolveStateCommand,
} from "../config.js";
import { GroveProjectConfig, PortDef } from "../types.js";
import { formatSlotCap, maxSlot } from "../ports.js";
import { regenerateAliases } from "../aliases.js";

interface RegisterOptions {
  name?: string;
  init?: string;
  teardown?: string;
  port?: string[];
  config?: string;
  update?: boolean;
}

export async function register(projectPath: string, options: RegisterOptions) {
  try {
    const absPath = path.resolve(projectPath);
    if (!fs.existsSync(absPath)) throw new Error(`path does not exist: ${absPath}`);

    const configFile = normalizeConfigFile(options.config ?? GROVE_CONFIG_FILE);
    const repoConfig = loadRepoConfig(absPath, configFile);
    if (options.config && !repoConfig) throw new Error(`no ${configFile} found at ${absPath}`);

    if (repoConfig?.devCommand) resolveDevCommand(absPath, repoConfig.devCommand);
    if (repoConfig?.stateCommand) resolveStateCommand(absPath, repoConfig.stateCommand);

    const ports: Record<string, PortDef> = { ...(repoConfig?.ports ?? {}) };
    if (options.port) {
      for (const value of options.port) {
        const parts = value.split(":");
        if (parts.length !== 3) {
          throw new Error(`invalid port format "${value}". Expected name:base:offset (e.g. core:3068:100)`);
        }
        const [portName, baseString, offsetString] = parts;
        const base = Number(baseString);
        const offset = Number(offsetString);
        if (!Number.isFinite(base) || !Number.isFinite(offset)) {
          throw new Error(`non-numeric port values in "${value}". Expected name:base:offset`);
        }
        ports[portName] = { base, offset };
      }
    }

    maxSlot(ports);

    const name = options.name ?? repoConfig?.name ?? path.basename(absPath);
    const initScript = options.init;
    const teardownScript = options.teardown ?? repoConfig?.teardownScript;
    const aliases = repoConfig?.aliases;

    await withRegistryLock(async (registry) => {
      const existing = registry.projects[name];
      if (existing && !options.update) {
        throw new Error(`project "${name}" already registered. Use a different --name, --update, or unregister first`);
      }

      let registered: GroveProjectConfig;
      if (existing) {
        existing.source = absPath;
        if (repoConfig) {
          existing.configFile = configFile;
          existing.ports = { ...ports };
          if (initScript) existing.initScript = initScript;
          else delete existing.initScript;
          if (teardownScript) existing.teardownScript = teardownScript;
          else delete existing.teardownScript;
          if (aliases) existing.aliases = aliases;
          else delete existing.aliases;
        } else {
          Object.assign(existing.ports, ports);
          if (initScript) existing.initScript = initScript;
          if (teardownScript) existing.teardownScript = teardownScript;
          if (aliases) existing.aliases = aliases;
        }
        registered = existing;
        await saveRegistry(registry);
        regenerateAliases(registry);
        printRegistration("Updated", name, absPath, registered, repoConfig);
        return;
      }

      registered = {
        source: absPath,
        configFile: repoConfig ? configFile : undefined,
        initScript,
        teardownScript,
        ports,
        instances: [],
        aliases,
      };
      registry.projects[name] = registered;
      await saveRegistry(registry);
      regenerateAliases(registry);
      printRegistration("Registered", name, absPath, registered, repoConfig);
    });
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function printRegistration(
  action: "Registered" | "Updated",
  name: string,
  source: string,
  project: { configFile?: string; initScript?: string; teardownScript?: string; ports: Record<string, PortDef> },
  repoConfig: ReturnType<typeof loadRepoConfig>,
): void {
  console.log(`${action} project "${name}"`);
  console.log(`  Source: ${source}`);
  if (project.configFile) console.log(`  Config: ${project.configFile}`);
  if (project.initScript) console.log(`  Init:   ${project.initScript}`);
  if (project.teardownScript) console.log(`  Teardown: ${project.teardownScript}`);
  if (repoConfig?.devCommand) console.log(`  Dev:    ${repoConfig.devCommand}`);
  if (repoConfig?.stateCommand) console.log(`  State:  ${repoConfig.stateCommand}`);
  if (Object.keys(project.ports).length) {
    console.log("  Ports:");
    for (const [portName, port] of Object.entries(project.ports)) {
      console.log(`    ${portName}: ${port.base} + slot × ${port.offset}`);
    }
  }
  console.log(`  Slot cap: ${formatSlotCap(maxSlot(project.ports))}`);
}

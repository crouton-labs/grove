import path from "path";
import fs from "fs";
import { loadRegistry, saveRegistry } from "../registry.js";
import { loadRepoConfig, hasSetupScript } from "../config.js";
import { PortDef } from "../types.js";

interface RegisterOptions {
  name?: string;
  init?: string;
  teardown?: string;
  port?: string[];
  fromConfig?: boolean;
  update?: boolean;
}

export async function register(projectPath: string, options: RegisterOptions) {
  const absPath = path.resolve(projectPath);
  if (!fs.existsSync(absPath)) {
    console.error(`Error: path does not exist: ${absPath}`);
    process.exit(1);
  }

  const registry = loadRegistry();

  const ports: Record<string, PortDef> = {};
  let initScript: string | undefined = options.init;
  let teardownScript: string | undefined = options.teardown;
  let resolvedName: string | undefined = options.name;

  if (options.fromConfig) {
    const repoConfig = loadRepoConfig(absPath);
    if (!repoConfig) {
      console.error(`Error: no ${".claude/grove/config.json"} found at ${absPath}`);
      process.exit(1);
    }

    Object.assign(ports, repoConfig.ports);
    if (!resolvedName && repoConfig.name) resolvedName = repoConfig.name;
    if (!teardownScript && repoConfig.teardownScript) teardownScript = repoConfig.teardownScript;
    if (!initScript && hasSetupScript(absPath)) initScript = ".claude/grove/setup.sh";
  } else {
    const repoConfig = loadRepoConfig(absPath);
    if (repoConfig && (!options.port || options.port.length === 0)) {
      console.log(
        `Hint: Found .claude/grove/config.json — use --from-config to load port definitions from it.`,
      );
    }
  }

  if (options.port) {
    for (const p of options.port) {
      const parts = p.split(":");
      if (parts.length !== 3) {
        console.error(
          `Error: invalid port format "${p}". Expected name:base:offset (e.g. core:3068:100)`,
        );
        process.exit(1);
      }
      const [portName, baseStr, offsetStr] = parts;
      const base = parseInt(baseStr, 10);
      const offset = parseInt(offsetStr, 10);
      if (isNaN(base) || isNaN(offset)) {
        console.error(
          `Error: non-numeric port values in "${p}". Expected name:base:offset`,
        );
        process.exit(1);
      }
      ports[portName] = { base, offset };
    }
  }

  const name = resolvedName || path.basename(absPath);

  if (registry.projects[name]) {
    if (!options.update) {
      console.error(
        `Error: project "${name}" already registered. Use a different --name, --update, or unregister first.`,
      );
      process.exit(1);
    }

    const existing = registry.projects[name];
    Object.assign(existing.ports, ports);
    if (initScript) existing.initScript = initScript;
    if (teardownScript) existing.teardownScript = teardownScript;
    saveRegistry(registry);

    console.log(`Updated project "${name}"`);
    console.log(`  Source: ${absPath}`);
    if (existing.initScript) console.log(`  Init:   ${existing.initScript}`);
    if (existing.teardownScript) console.log(`  Teardown: ${existing.teardownScript}`);
    if (Object.keys(existing.ports).length) {
      console.log(`  Ports:`);
      for (const [n, p] of Object.entries(existing.ports)) {
        console.log(`    ${n}: ${p.base} + slot × ${p.offset}`);
      }
    }
    return;
  }

  registry.projects[name] = {
    source: absPath,
    initScript,
    teardownScript,
    ports,
    instances: [],
  };

  saveRegistry(registry);

  console.log(`Registered project "${name}"`);
  console.log(`  Source: ${absPath}`);
  if (initScript) console.log(`  Init:   ${initScript}`);
  if (teardownScript) console.log(`  Teardown: ${teardownScript}`);
  if (Object.keys(ports).length) {
    console.log(`  Ports:`);
    for (const [n, p] of Object.entries(ports)) {
      console.log(`    ${n}: ${p.base} + slot × ${p.offset}`);
    }
  }
}

import path from "path";
import fs from "fs";
import { loadRegistry, saveRegistry } from "../registry.js";
import { PortDef } from "../types.js";

interface RegisterOptions {
  name?: string;
  init?: string;
  teardown?: string;
  port?: string[];
}

export async function register(projectPath: string, options: RegisterOptions) {
  const absPath = path.resolve(projectPath);
  if (!fs.existsSync(absPath)) {
    console.error(`Error: path does not exist: ${absPath}`);
    process.exit(1);
  }

  const name = options.name || path.basename(absPath);
  const registry = loadRegistry();

  if (registry.projects[name]) {
    console.error(
      `Error: project "${name}" already registered. Use a different --name or unregister first.`,
    );
    process.exit(1);
  }

  const ports: Record<string, PortDef> = {};
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

  registry.projects[name] = {
    source: absPath,
    initScript: options.init,
    teardownScript: options.teardown,
    ports,
    instances: [],
  };

  saveRegistry(registry);

  console.log(`Registered project "${name}"`);
  console.log(`  Source: ${absPath}`);
  if (options.init) console.log(`  Init:   ${options.init}`);
  if (options.teardown) console.log(`  Teardown: ${options.teardown}`);
  if (Object.keys(ports).length) {
    console.log(`  Ports:`);
    for (const [n, p] of Object.entries(ports)) {
      console.log(`    ${n}: ${p.base} + slot × ${p.offset}`);
    }
  }
}

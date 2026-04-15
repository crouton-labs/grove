import fs from "fs";
import { loadRegistry } from "../registry.js";
import { computePorts, checkPort } from "../ports.js";

export async function list(project?: string) {
  const registry = loadRegistry();

  const names = project ? [project] : Object.keys(registry.projects);

  if (names.length === 0) {
    console.log("No projects registered. Run: grove register <path>");
    return;
  }

  for (const name of names) {
    const proj = registry.projects[name];
    if (!proj) {
      console.error(`Unknown project: ${name}`);
      continue;
    }

    const sourceOk = fs.existsSync(proj.source);
    console.log(
      `\x1b[1m${name}\x1b[0m${sourceOk ? "" : " \x1b[31m(source missing)\x1b[0m"}`,
    );
    console.log(`  ${proj.source}`);

    if (proj.instances.length === 0) {
      console.log("  (no instances)\n");
      continue;
    }

    for (const inst of proj.instances) {
      const exists = fs.existsSync(inst.path);

      if (!exists) {
        console.log(
          `  \x1b[31m✗\x1b[0m ${inst.name} \x1b[90m(slot ${inst.slot})\x1b[0m ${inst.path}`,
        );
        console.log("    \x1b[31mzombie — directory missing. Run grove doctor\x1b[0m");
        continue;
      }

      console.log(
        `  \x1b[32m●\x1b[0m ${inst.name} \x1b[90m(slot ${inst.slot})\x1b[0m ${inst.path}`,
      );

      // Port health
      const portDefs = proj.ports;
      if (Object.keys(portDefs).length) {
        const ports = computePorts(portDefs, inst.slot);
        const checks = await Promise.all(
          Object.entries(ports).map(async ([svc, port]) => {
            const up = await checkPort(port);
            const icon = up
              ? `\x1b[32m●\x1b[0m`
              : `\x1b[90m○\x1b[0m`;
            return `${svc}:${port} ${icon}`;
          }),
        );
        console.log(`    ${checks.join("  ")}`);
      }
    }
    console.log("");
  }
}

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { loadRegistry, saveRegistry, nextFreeSlot } from "../registry.js";
import { computePorts } from "../ports.js";
import { loadRepoConfig, hasSetupScript, GROVE_SETUP_FILE, GROVE_CONFIG_FILE } from "../config.js";

interface PlantOptions {
  slot?: string;
  path?: string;
}

export async function plant(
  project: string,
  name: string,
  options: PlantOptions,
) {
  const registry = loadRegistry();
  const proj = registry.projects[project];

  if (!proj) {
    const available = Object.keys(registry.projects);
    console.error(`Error: project "${project}" not registered.`);
    if (available.length) {
      console.error(`Registered projects: ${available.join(", ")}`);
    } else {
      console.error("No projects registered. Run: grove register <path>");
    }
    process.exit(1);
  }

  if (!fs.existsSync(proj.source)) {
    console.error(`Error: source path no longer exists: ${proj.source}`);
    process.exit(1);
  }

  if (proj.instances.find((i) => i.name === name)) {
    console.error(
      `Error: instance "${name}" already exists for project "${project}".`,
    );
    process.exit(1);
  }

  // Slot assignment
  const usedSlots = new Set(proj.instances.map((i) => i.slot));
  let slot: number;
  if (options.slot) {
    slot = parseInt(options.slot, 10);
    if (isNaN(slot) || slot < 1 || slot > 9) {
      console.error("Error: slot must be 1-9.");
      process.exit(1);
    }
    if (usedSlots.has(slot)) {
      console.error(`Error: slot ${slot} already in use by another instance.`);
      process.exit(1);
    }
  } else {
    slot = nextFreeSlot(usedSlots);
  }

  // Target path — sibling to source, named <name>
  const targetPath = options.path
    ? path.resolve(options.path)
    : path.join(path.dirname(proj.source), name);

  if (fs.existsSync(targetPath)) {
    console.error(`Error: target already exists: ${targetPath}`);
    process.exit(1);
  }

  const ports = computePorts(proj.ports, slot);

  console.log(`Planting ${project}/${name} (slot ${slot})`);
  console.log(`  Source: ${proj.source}`);
  console.log(`  Target: ${targetPath}`);
  if (Object.keys(ports).length) {
    console.log(`  Ports:`);
    for (const [svc, port] of Object.entries(ports)) {
      console.log(`    ${svc}: ${port}`);
    }
  }
  console.log("");

  const repoConfig = loadRepoConfig(proj.source);
  const setupScriptExists = hasSetupScript(proj.source);

  if (repoConfig) {
    const configPortKeys = Object.keys(repoConfig.ports).sort().join(",");
    const registryPortKeys = Object.keys(proj.ports).sort().join(",");
    if (configPortKeys !== registryPortKeys) {
      console.warn(`Warning: registry ports differ from ${GROVE_CONFIG_FILE}`);
      console.warn(`Run: grove register "${proj.source}" --from-config --update`);
    }
  }

  const shouldSetupHandleCopy = repoConfig?.setupHandlesCopy === true && setupScriptExists;

  if (shouldSetupHandleCopy) {
    console.log("Setup script will handle copy and configuration...");
  } else if (proj.initScript) {
    const scriptPath = path.join(proj.source, proj.initScript);
    if (!fs.existsSync(scriptPath)) {
      console.error(`Error: init script not found: ${scriptPath}`);
      process.exit(1);
    }

    console.log(`Running init script: ${proj.initScript}`);
    try {
      execSync(
        `bash "${scriptPath}" "${proj.source}" "${targetPath}" ${slot} "${name}"`,
        { stdio: "inherit", cwd: proj.source },
      );
    } catch {
      console.error("Init script failed.");
      process.exit(1);
    }
  } else {
    const defaultExcludes = ["node_modules", ".next", "dist", ".turbo", ".cache", "*.tsbuildinfo"];
    const excludeList = repoConfig?.excludes ?? defaultExcludes;
    const excludes = excludeList.map((d) => `--exclude="${d}"`).join(" ");
    console.log("Copying source...");
    execSync(`rsync -a ${excludes} "${proj.source}/" "${targetPath}/"`, {
      stdio: "inherit",
    });
  }

  if (setupScriptExists) {
    const setupPath = path.join(
      shouldSetupHandleCopy ? proj.source : targetPath,
      GROVE_SETUP_FILE,
    );
    const mode = shouldSetupHandleCopy ? "full" : "post-copy";

    console.log(`Running setup script (mode: ${mode})...`);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GROVE_SLOT: String(slot),
      GROVE_SOURCE: proj.source,
      GROVE_TARGET: targetPath,
      GROVE_INSTANCE_NAME: name,
      GROVE_PORTS_JSON: JSON.stringify(ports),
    };
    for (const [portName, portValue] of Object.entries(ports)) {
      env[`GROVE_PORT_${portName.toUpperCase().replace(/-/g, "_")}`] = String(portValue);
    }

    try {
      execSync(
        `bash "${setupPath}" --mode ${mode} --source "${proj.source}" --target "${targetPath}" --slot ${slot} --name "${name}"`,
        { stdio: "inherit", cwd: proj.source, env },
      );
    } catch {
      console.error("Warning: setup script failed. Instance will be registered but may need manual setup.");
    }
  }

  if (!fs.existsSync(targetPath)) {
    if (shouldSetupHandleCopy) {
      console.error("Error: setup script did not create target directory.");
    } else {
      console.error("Error: target was not created.");
    }
    process.exit(1);
  }

  // Symlink grove's plant command into the new instance
  const groveCommandSrc = path.resolve(
    new URL("../../commands/plant.md", import.meta.url).pathname,
  );
  const claudeCommandsDir = path.join(targetPath, ".claude", "commands");
  if (fs.existsSync(claudeCommandsDir) && fs.existsSync(groveCommandSrc)) {
    const symlinkTarget = path.join(claudeCommandsDir, "grove-plant.md");
    try {
      fs.unlinkSync(symlinkTarget);
    } catch {
      // Doesn't exist yet — fine
    }
    fs.symlinkSync(groveCommandSrc, symlinkTarget);
  }

  // Register
  proj.instances.push({
    name,
    path: targetPath,
    slot,
    created: new Date().toISOString(),
  });
  saveRegistry(registry);

  // Structured output for Claude consumption
  const summary = {
    project,
    instance: name,
    slot,
    source: proj.source,
    target: targetPath,
    ports,
  };

  console.log("");
  console.log(`Planted: ${project}/${name}`);
  console.log("");
  console.log("--- grove-output ---");
  console.log(JSON.stringify(summary, null, 2));
}

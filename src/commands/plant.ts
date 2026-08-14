import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { loadRegistry, saveRegistry, nextFreeSlot } from "../registry.js";
import { computePorts } from "../ports.js";
import {
  GROVE_CONFIG_FILE,
  loadRepoConfig,
  hasSetupScript,
  resolveProjectPath,
  setupFileForConfig,
} from "../config.js";
import { cloneRepos, copyFromSource, patchPorts, runInstalls, runSecrets } from "../setup.js";
import { expandTilde } from "../paths.js";
import { regenerateAliases } from "../aliases.js";
import { groveContextEnv } from "../context.js";
import {
  BASELINE_REF,
  applyRef,
  describeRef,
  hasStateCommand,
  resolveRef,
  type StateRef,
} from "../state.js";

interface PlantOptions {
  slot?: string;
  path?: string;
  from?: string;
  ignoreFingerprint?: boolean;
}

export async function plant(
  project: string,
  name: string | undefined,
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

  // Name defaults to the slot number, so `grove plant <project>` yields 1, 2, 3, ...
  name = name ?? String(slot);

  if (proj.instances.find((i) => i.name === name)) {
    console.error(
      `Error: instance "${name}" already exists for project "${project}".`,
    );
    process.exit(1);
  }

  // Target path — under config.instancesDir if set (resolved relative to source,
  // with ~ expansion), otherwise a sibling of the source. An explicit --path always wins.
  const configFile = proj.configFile ?? GROVE_CONFIG_FILE;
  const repoConfig = loadRepoConfig(proj.source, configFile);
  const baseDir = repoConfig?.instancesDir
    ? path.resolve(proj.source, expandTilde(repoConfig.instancesDir))
    : path.dirname(proj.source);
  const targetPath = options.path
    ? path.resolve(options.path)
    : path.join(baseDir, name);

  if (!options.path) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  if (fs.existsSync(targetPath)) {
    console.error(`Error: target already exists: ${targetPath}`);
    process.exit(1);
  }

  const ports = computePorts(proj.ports, slot);

  // Resolve the state ref before any filesystem work: a typo should fail in a
  // second, not after a full clone-and-install.
  let stateRef: StateRef | undefined;
  try {
    stateRef = resolveRef(project, proj, options.from ?? BASELINE_REF);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }

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

  const setupScriptExists = hasSetupScript(proj.source, configFile);

  if (repoConfig) {
    const configPortKeys = Object.keys(repoConfig.ports).sort().join(",");
    const registryPortKeys = Object.keys(proj.ports).sort().join(",");
    if (configPortKeys !== registryPortKeys) {
      console.warn(`Warning: registry ports differ from ${configFile}`);
      console.warn(`Run: grove register "${proj.source}" --config "${configFile}" --update`);
    }
  }

  // --- Copy phase ---
  if (repoConfig?.repos) {
    console.log("Cloning repos...");
    cloneRepos(proj.source, targetPath, repoConfig.repos);
  } else if (proj.initScript) {
    const scriptPath = resolveProjectPath(proj.source, proj.initScript);
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

  // --- Config-driven setup ---
  if (repoConfig?.copyFromSource) {
    console.log("Copying files from source...");
    copyFromSource(
      proj.source,
      targetPath,
      repoConfig.copyFromSource,
      proj.ports,
      slot,
      configFile,
    );
  }

  // Secrets run before port patching so a generated .env gets slot ports the
  // same way a copied one does.
  if (repoConfig?.secrets) {
    console.log("Materializing secrets...");
    try {
      runSecrets(targetPath, repoConfig.secrets);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  if (repoConfig?.patchPortsIn) {
    console.log("Patching port references...");
    patchPorts(targetPath, repoConfig.patchPortsIn, proj.ports, slot, configFile);
  }

  if (repoConfig?.install) {
    console.log("Installing dependencies...");
    runInstalls(targetPath, repoConfig.install);
  }

  // --- setup.sh (runs last for anything config can't express) ---
  if (setupScriptExists) {
    const setupPath = resolveProjectPath(targetPath, setupFileForConfig(configFile));

    console.log("Running setup script...");

    const env = groveContextEnv({
      source: proj.source,
      target: targetPath,
      slot,
      instanceName: name,
      ports,
    });

    try {
      execSync(`bash "${setupPath}"`, { stdio: "inherit", cwd: targetPath, env });
    } catch {
      console.error("Warning: setup script failed. Instance will be registered but may need manual setup.");
    }
  }

  if (!fs.existsSync(targetPath)) {
    console.error("Error: target was not created.");
    process.exit(1);
  }

  // --- State (runs last: setup.sh has provisioned the stores it writes into) ---
  const stateContext = {
    source: proj.source,
    target: targetPath,
    slot,
    instanceName: name,
    ports,
  };
  const stateConfigured = hasStateCommand(proj, stateContext);
  if (!stateConfigured && options.from) {
    console.error(
      `Error: --from ${options.from} was given but ${configFile} has no stateCommand.`,
    );
    process.exit(1);
  }
  if (stateConfigured && stateRef) {
    console.log(`Applying state: ${describeRef(stateRef)}`);
    try {
      applyRef(proj, stateRef, stateContext, options.ignoreFingerprint === true);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      console.error(
        `The instance exists at ${targetPath} but is unregistered. Remove it, or re-run state setup by hand.`,
      );
      process.exit(1);
    }
  }

  // Register
  proj.instances.push({
    name,
    path: targetPath,
    slot,
    created: new Date().toISOString(),
  });
  saveRegistry(registry);
  regenerateAliases(registry);

  // Structured output for automation
  const summary = {
    project,
    instance: name,
    slot,
    source: proj.source,
    target: targetPath,
    ports,
    from: stateConfigured && stateRef ? (options.from ?? BASELINE_REF) : null,
  };

  console.log("");
  console.log(`Planted: ${project}/${name}`);
  console.log("");
  console.log("--- grove-output ---");
  console.log(JSON.stringify(summary, null, 2));
}

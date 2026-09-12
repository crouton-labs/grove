import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "node:util";
import { loadRegistry, saveRegistry, withRegistryLock, nextFreeSlot } from "../registry.js";
import { computePorts, formatSlotCap, maxSlot } from "../ports.js";
import {
  GROVE_CONFIG_FILE,
  loadRepoConfig,
  hasSetupScript,
  resolveProjectPath,
  setupFileForConfig,
} from "../config.js";
import {
  applySubstitutions,
  cloneRepos,
  cloneReposFromSource,
  copyFromSource,
  describeClonedRepos,
  patchPorts,
  resolveSourceCommits,
  runInstalls,
  runSecrets,
  type CodeSource,
  type SourceRepoCommit,
} from "../setup.js";
import { expandTilde } from "../paths.js";
import { regenerateAliases } from "../aliases.js";
import { groveContextEnv, type GroveExecutionContext } from "../context.js";
import { validateSharedEnv } from "../env.js";
import { loadSettings, type GroveSettings } from "../settings.js";
import {
  BASELINE_REF,
  applyRef,
  describeRef,
  hasStateCommand,
  resolveRef,
  sourceContext,
  type StateRef,
} from "../state.js";
import type { GroveInstance } from "../types.js";

interface PlantOptions {
  slot?: string;
  path?: string;
  codeFrom?: string;
  from?: string;
  ignoreFingerprint?: boolean;
}

export async function plant(
  project: string,
  name: string | undefined,
  options: PlantOptions,
) {
  const codeFrom = (options.codeFrom ?? "configured") as CodeSource;
  if (codeFrom !== "configured" && codeFrom !== "@source") {
    console.error(
      `Error: --code-from must be "configured" or "@source", got "${options.codeFrom}".`,
    );
    process.exit(1);
  }

  try {
    validateSharedEnv(project);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }

  const registry = loadRegistry();
  let proj = registry.projects[project];

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

  const configFile = proj.configFile ?? GROVE_CONFIG_FILE;
  const repoConfig = loadRepoConfig(proj.source, configFile);
  if (repoConfig?.nameIsSlot && options.path) {
    console.error(`Error: ${project} declares nameIsSlot; its instance path is derived from the slot (<instancesDir>/<slot>). Remove --path.`);
    process.exit(1);
  }
  if (repoConfig?.nameIsSlot && name !== undefined && !/^[1-9]\d*$/.test(name)) {
    console.error(`Error: ${project} declares nameIsSlot; its instances are named by a positive slot number. Drop the name: grove plant ${project} [--slot N].`);
    process.exit(1);
  }

  // Target path is finalized while the registry lock is held, after its slot is reserved.
  const baseDir = repoConfig?.instancesDir
    ? path.resolve(proj.source, expandTilde(repoConfig.instancesDir))
    : path.dirname(proj.source);
  let slot: number;
  let targetPath: string;
  let ports: Record<string, number>;

  // Resolve the state ref before any filesystem work: a typo should fail in a
  // second, not after a full clone-and-install.
  let stateRef: StateRef | undefined;
  try {
    stateRef = resolveRef(project, proj, options.from ?? BASELINE_REF);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
  const stateConfigured = hasStateCommand(proj, sourceContext(proj, project));
  if (options.from && !stateConfigured) {
    console.error(
      `Error: --from ${options.from} was given but ${configFile} has no stateCommand.`,
    );
    process.exit(1);
  }

  // Same reason as the ref: a dirty source repo must stop the plant now, not
  // after a full clone-and-install.
  let sourceCommits: Record<string, SourceRepoCommit> | undefined;
  if (codeFrom === "@source") {
    if (!repoConfig?.repos) {
      console.error(
        `Error: --code-from @source needs a repos map in ${configFile}; this project copies its source directly.`,
      );
      process.exit(1);
    }
    try {
      sourceCommits = resolveSourceCommits(proj.source, repoConfig.repos);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  let settings: GroveSettings;
  try {
    settings = loadSettings();
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }

  const pendingRef = stateConfigured && stateRef ? (options.from ?? BASELINE_REF) : undefined;
  const reservationId = randomUUID();
  let reservation: { project: NonNullable<typeof proj>; name: string; slot: number; path: string; ports: Record<string, number> };
  try {
  reservation = await withRegistryLock(async (currentRegistry) => {
    const currentProject = currentRegistry.projects[project];
    if (!currentProject) {
      throw new Error(`project "${project}" is no longer registered`);
    }
    if (
      currentProject.source !== proj.source ||
      currentProject.configFile !== proj.configFile ||
      currentProject.initScript !== proj.initScript ||
      !isDeepStrictEqual(currentProject.ports, proj.ports)
    ) {
      throw new Error(`project "${project}" changed while plant was preparing; rerun the command`);
    }
    const cap = maxSlot(currentProject.ports);
    if (cap < 1) {
      throw new Error(`${project} has no usable instance slots (cap ${formatSlotCap(cap)})`);
    }

    const usedSlots = new Set(currentProject.instances.map((instance) => instance.slot));
    let reservedSlot: number;
    if (options.slot !== undefined) {
      if (!/^[1-9]\d*$/.test(options.slot)) {
        throw new Error("slot must be a positive integer");
      }
      reservedSlot = Number(options.slot);
      if (!Number.isSafeInteger(reservedSlot)) {
        throw new Error("slot must be a positive safe integer");
      }
      if (reservedSlot > cap) {
        throw new Error(`slot ${reservedSlot} exceeds the project slot cap (${formatSlotCap(cap)})`);
      }
      if (usedSlots.has(reservedSlot)) {
        throw new Error(`slot ${reservedSlot} already in use by another instance`);
      }
    } else {
      reservedSlot = nextFreeSlot(usedSlots);
      if (reservedSlot > cap) {
        throw new Error(`no free slots (cap ${formatSlotCap(cap)})`);
      }
    }

    const instanceName = name ?? String(reservedSlot);
    if (repoConfig?.nameIsSlot && instanceName !== String(reservedSlot)) {
      throw new Error(`${project} declares nameIsSlot; its instances are named by slot number. Drop the name: grove plant ${project} [--slot N]`);
    }
    if (currentProject.instances.some((instance) => instance.name === instanceName)) {
      throw new Error(`instance "${instanceName}" already exists for project "${project}"`);
    }

    const reservedPath = options.path
      ? path.resolve(options.path)
      : path.join(baseDir, instanceName);
    if (fs.existsSync(reservedPath)) {
      throw new Error(`target already exists: ${reservedPath}`);
    }

    const reservedPorts = computePorts(currentProject.ports, reservedSlot);
    groveContextEnv({
      projectName: project,
      source: currentProject.source,
      target: reservedPath,
      slot: reservedSlot,
      instanceName,
      ports: reservedPorts,
    }, process.env, settings);
    const instance: GroveInstance = {
      name: instanceName,
      path: reservedPath,
      slot: reservedSlot,
      created: new Date().toISOString(),
      pending: "planting",
      reservationId,
    };
    if (pendingRef) instance.needsState = pendingRef;
    currentProject.instances.push(instance);
    await saveRegistry(currentRegistry);
    regenerateAliases(currentRegistry);
    return { project: currentProject, name: instanceName, slot: reservedSlot, path: reservedPath, ports: reservedPorts };
  });
  } catch (error) {
    console.error(`Error: ${(error as Error).message}.`);
    process.exit(1);
  }
  proj = reservation.project;
  name = reservation.name;
  slot = reservation.slot;
  targetPath = reservation.path;
  ports = reservation.ports;
  const executionContext: GroveExecutionContext = {
    projectName: project,
    source: proj.source,
    target: targetPath,
    slot,
    instanceName: name,
    ports,
  };
  if (!options.path) fs.mkdirSync(baseDir, { recursive: true });

  console.log(`Planting ${project}/${name} (slot ${slot})`);
  console.log(`  Source: ${proj.source}`);
  console.log(`  Target: ${targetPath}`);
  if (repoConfig?.repos) {
    console.log(
      `  Code:   ${codeFrom === "@source" ? "source checkout commits" : "configured branches"}`,
    );
  }
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
  if (repoConfig?.repos && sourceCommits) {
    console.log("Cloning repos at source commits...");
    cloneReposFromSource(targetPath, repoConfig.repos, sourceCommits);
  } else if (repoConfig?.repos) {
    console.log("Cloning repos...");
    cloneRepos(proj.source, targetPath, repoConfig.repos);
  } else if (proj.initScript) {
    const scriptPath = resolveProjectPath(proj.source, proj.initScript);
    if (!fs.existsSync(scriptPath)) {
      console.error(`Error: init script not found: ${scriptPath}`);
      process.exit(1);
    }

    console.log(`Running init script: ${proj.initScript}`);
    let initEnv: NodeJS.ProcessEnv;
    try {
      initEnv = groveContextEnv(executionContext, process.env, settings);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
    try {
      execSync(
        `bash "${scriptPath}" "${proj.source}" "${targetPath}" ${slot} "${name}"`,
        { stdio: "inherit", cwd: proj.source, env: initEnv },
      );
    } catch {
      console.error("Init script failed.");
      process.exit(1);
    }
  } else {
    const defaultExcludes = ["node_modules", ".next", "dist", ".turbo", ".cache", "*.tsbuildinfo"];
    const excludeList = repoConfig?.excludes ?? defaultExcludes;
    const excludes = ["/.grove/env", ...excludeList].map((d) => `--exclude="${d}"`).join(" ");
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
      runSecrets(targetPath, repoConfig.secrets, () => groveContextEnv(executionContext, process.env, settings));
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  if (repoConfig?.patchPortsIn) {
    console.log("Patching port references...");
    patchPorts(targetPath, repoConfig.patchPortsIn, proj.ports, slot, configFile);
  }

  // After ports: a substitution rule may rewrite a value a port patch just
  // touched (a URL carrying both a hostname and a port), and the string rule is
  // the more specific statement of the two.
  if (repoConfig?.substituteIn) {
    console.log("Applying per-slot substitutions...");
    let machine: string;
    try {
      machine = groveContextEnv(executionContext, process.env, settings).GROVE_MACHINE!;
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
    applySubstitutions(targetPath, repoConfig.substituteIn, slot, machine, configFile);
  }

  if (repoConfig?.install) {
    console.log("Installing dependencies...");
    try {
      runInstalls(targetPath, repoConfig.install, () => groveContextEnv(executionContext, process.env, settings));
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  // --- setup.sh (runs last for anything config can't express) ---
  if (setupScriptExists) {
    const setupPath = resolveProjectPath(targetPath, setupFileForConfig(configFile));

    console.log("Running setup script...");

    let setupEnv: NodeJS.ProcessEnv;
    try {
      setupEnv = groveContextEnv(executionContext, process.env, settings);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
    try {
      execSync(`bash "${setupPath}"`, { stdio: "inherit", cwd: targetPath, env: setupEnv });
    } catch {
      console.error(`Error: setup script failed. Remove the partial planting with: grove uproot ${project}/${name}`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(targetPath)) {
    console.error("Error: target was not created.");
    process.exit(1);
  }

  // --- State (runs last: setup.sh has provisioned the stores it writes into) ---
  const stateContext = executionContext;
  if (stateConfigured && stateRef) {
    console.log(`Applying state: ${describeRef(stateRef)}`);
    try {
      applyRef(proj, stateRef, stateContext, options.ignoreFingerprint === true);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      console.error("");
      console.error(`${project}/${name} is still planting and cannot be used.`);
      console.error(`  Remove: grove uproot ${project}/${name}`);
      process.exit(1);
    }
  }

  try {
    await withRegistryLock(async (currentRegistry) => {
      const instance = currentRegistry.projects[project]?.instances.find(
        (candidate) => candidate.name === name && candidate.slot === slot && candidate.reservationId === reservationId,
      );
      if (!instance) throw new Error(`${project}/${name} is no longer registered`);
      delete instance.pending;
      delete instance.reservationId;
      delete instance.needsState;
      await saveRegistry(currentRegistry);
      regenerateAliases(currentRegistry);
    });
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }

  // Structured output for automation
  const summary = {
    project,
    instance: name,
    slot,
    source: proj.source,
    target: targetPath,
    ports,
    from: stateConfigured && stateRef ? (options.from ?? BASELINE_REF) : null,
    code: repoConfig?.repos
      ? { mode: codeFrom, repos: describeClonedRepos(targetPath, repoConfig.repos) }
      : null,
  };

  console.log("");
  console.log(`Planted: ${project}/${name}`);
  console.log("");
  console.log("--- grove-output ---");
  console.log(JSON.stringify(summary, null, 2));
}

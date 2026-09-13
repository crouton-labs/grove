import fs from "fs";
import path from "path";
import { execFileSync, execSync } from "child_process";
import { saveRegistry, withRegistryLock } from "../registry.js";
import { confirm } from "../prompt.js";
import { computePorts, checkPort } from "../ports.js";
import { isWithinRoot, loadRepoConfig, resolveProjectPath } from "../config.js";
import { configuredRepositories } from "../revisions.js";
import { stopInstanceServices } from "../process.js";
import { regenerateAliases } from "../aliases.js";
import { groveContextEnv, type GroveSibling } from "../context.js";
import { announceSelectionTarget, runSequential, selectTargets, type TargetingOptions } from "../selection.js";
import { pendingError } from "../state.js";
import { TargetNotFoundError, targetErrorExitCode, type GroveTarget } from "../target.js";

interface UprootOptions extends TargetingOptions {
  force?: boolean;
  owner?: string;
}

export class OwnerChangedError extends Error {}

interface UprootTargetOptions {
  force?: boolean;
  owner?: string;
  externalWorktrees?: string[];
  quiet?: boolean;
  teardownFailure?: "abort";
}

export async function uproot(targetOrProject: string | undefined, options: UprootOptions): Promise<void> {
  try {
    const selection = selectTargets(targetOrProject, options, process.cwd());
    if (selection.fanOut && !options.force) {
      throw new Error("uproot with a selector or --all requires --force");
    }
    process.exitCode = selection.fanOut
      ? await runSequential(selection.targets, (target) => uprootTarget(target, options), selection.source)
      : (announceSelectionTarget(selection.targets[0], selection.source), await uprootTarget(selection.targets[0], options));
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = targetErrorExitCode(error);
  }
}

export async function uprootTarget(target: GroveTarget, options: UprootTargetOptions): Promise<number> {
  if (!target.instance) {
    throw new Error(`${target.projectName} is the project source; grove uproot needs a planted instance`);
  }
  const { project: proj, projectName: project, instance } = target;
  if (instance.pending === "applying" || instance.pending === "restoring" || instance.pending === "releasing" || instance.pending === "rolling-out" || instance.pending === "rolling-back") {
    throw new Error(pendingError(project, instance));
  }
  const instanceName = instance.name;
  const exists = fs.existsSync(instance.path);
  const log = options.quiet ? (() => {}) : console.log;
  const error = options.quiet ? (() => {}) : console.error;
  const externalWorktrees = options.externalWorktrees ?? instance.uprootWorktrees ?? recordedExternalWorktrees(target);

  log(`Uprooting ${project}/${instanceName}`);
  log(`  Path: ${instance.path}${exists ? "" : " (already gone)"}`);
  log(`  Slot: ${instance.slot}`);

  const ports = computePorts(proj.ports, instance.slot);
  let teardownPath: string | null = null;
  let teardownScript: string | undefined;
  let contextEnv: NodeJS.ProcessEnv | undefined;
  if (exists) {
    const repoConfig = loadRepoConfig(instance.path, proj.configFile);
    teardownScript = repoConfig?.teardownScript ?? proj.teardownScript;
    if (teardownScript) {
      const scriptPath = resolveProjectPath(instance.path, teardownScript);
      const fallbackPath = resolveProjectPath(proj.source, teardownScript);
      teardownPath = fs.existsSync(scriptPath) ? scriptPath : fs.existsSync(fallbackPath) ? fallbackPath : null;
    }
  }

  if (Object.keys(ports).length) {
    log("  Ports:");
    for (const [svc, port] of Object.entries(ports)) {
      const up = await checkPort(port);
      log(`    ${svc}: ${port} ${up ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m"}`);
    }
  }

  if (!options.force) {
    if (!process.stdin.isTTY) {
      throw new Error("non-interactive shell. Use --force to skip confirmation.");
    }
    const ok = await confirm("\nProceed? (y/N) ");
    if (!ok) {
      console.log("Cancelled.");
      return 0;
    }
  }

  const siblings = await withRegistryLock(async (currentRegistry) => {
    const currentProject = currentRegistry.projects[project];
    const currentIndex = currentProject?.instances.findIndex((candidate) =>
      candidate.name === instanceName &&
      candidate.slot === instance.slot &&
      candidate.path === instance.path &&
      candidate.created === instance.created,
    ) ?? -1;
    if (!currentProject || currentIndex === -1) {
      throw new TargetNotFoundError(`${project}/${instanceName} is no longer registered`);
    }
    const currentInstance = currentProject.instances[currentIndex];
    if (currentInstance.pending === "applying" || currentInstance.pending === "restoring" || currentInstance.pending === "releasing" || currentInstance.pending === "rolling-out" || currentInstance.pending === "rolling-back") {
      throw new Error(pendingError(project, currentInstance));
    }
    if (options.owner !== undefined && currentInstance.spec.labels.owner !== options.owner) {
      throw new OwnerChangedError(`${project}/${instanceName} owner changed before removal`);
    }
    currentInstance.pending = "uprooting";
    currentInstance.uprootWorktrees = externalWorktrees;
    delete currentInstance.reservationId;
    await saveRegistry(currentRegistry);
    return [
      { name: project, slot: 0, path: currentProject.source },
      ...currentProject.instances
        .filter((_, index) => index !== currentIndex)
        .map(({ name, slot, path }) => ({ name, slot, path })),
    ].sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  });

  try {
    if (teardownPath) {
      contextEnv = groveContextEnv({
        projectName: project,
        source: proj.source,
        target: instance.path,
        slot: instance.slot,
        instanceName,
        ports,
      }, process.env, undefined, siblings);
    }

    log("\nStopping services...");
    const { killed, portsFreed } = await stopInstanceServices(instance.path, ports, log);
    if (killed > 0) {
      log(`  Killed ${killed} process${killed > 1 ? "es" : ""}.`);
    } else {
      log("  No running services found.");
    }
    if (!portsFreed) {
      log("\n\x1b[33m⚠\x1b[0m Some ports could not be freed. Continuing with teardown.");
    }

    if (teardownPath && teardownScript && contextEnv) {
      log(`\nRunning teardown script: ${teardownScript}`);
      try {
        execSync(`bash "${teardownPath}"`, {
          stdio: options.quiet ? "ignore" : "inherit",
          cwd: instance.path,
          env: contextEnv,
        });
      } catch (failure) {
        if (options.teardownFailure === "abort") {
          throw new Error(`teardown script failed: ${(failure as Error).message}`);
        }
        error("  Warning: teardown script failed.");
      }
    }

    for (const worktreePath of externalWorktrees) {
      if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    if (exists) {
      log(`\nRemoving ${instance.path}...`);
      fs.rmSync(instance.path, { recursive: true, force: true });
    }

    await withRegistryLock(async (currentRegistry) => {
      const currentProject = currentRegistry.projects[project];
      const currentIndex = currentProject?.instances.findIndex((candidate) =>
        candidate.name === instanceName &&
        candidate.slot === instance.slot &&
        candidate.path === instance.path &&
        candidate.created === instance.created,
      ) ?? -1;
      if (!currentProject || currentIndex === -1) {
        throw new TargetNotFoundError(`${project}/${instanceName} is no longer registered`);
      }
      currentProject.instances.splice(currentIndex, 1);
      await saveRegistry(currentRegistry);
      regenerateAliases(currentRegistry);
    });
  } catch (error) {
    if (fs.existsSync(instance.path)) await releaseUprootReservation(target);
    throw error;
  }

  log(`\nUprooted ${project}/${instanceName}.`);
  return 0;
}

async function releaseUprootReservation(target: GroveTarget): Promise<void> {
  const instance = target.instance!;
  await withRegistryLock(async (registry) => {
    const project = registry.projects[target.projectName];
    const current = project?.instances.find((candidate) =>
      candidate.name === instance.name &&
      candidate.slot === instance.slot &&
      candidate.path === instance.path &&
      candidate.created === instance.created,
    );
    if (!current) throw new TargetNotFoundError(`${target.projectName}/${instance.name} is no longer registered`);
    delete current.pending;
    delete current.uprootWorktrees;
    await saveRegistry(registry);
  });
}

/** Git itself reports the only worktrees Grove is allowed to remove. */
function recordedExternalWorktrees(target: GroveTarget): string[] {
  if (!target.instance || !fs.existsSync(target.instance.path)) return [];
  const config = loadRepoConfig(target.project.source, target.project.configFile);
  if (!config?.repos || Object.keys(config.repos).length === 0) return [];
  const repositories = configuredRepositories(target.instance.path, config, "uproot");
  const paths = new Set<string>();
  for (const repository of repositories) {
    let output: string;
    try {
      output = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repository.path, encoding: "utf-8" });
    } catch (failure) {
      throw new Error(`cannot uproot ${repository.name}: ${(failure as Error).message}`);
    }
    for (const line of output.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const worktreePath = path.resolve(line.slice("worktree ".length));
      if (!isWithinRoot(path.resolve(target.instance.path), worktreePath)) paths.add(worktreePath);
    }
  }
  return [...paths];
}

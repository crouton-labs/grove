import fs from "fs";
import { execSync } from "child_process";
import { saveRegistry, withRegistryLock } from "../registry.js";
import { confirm } from "../prompt.js";
import { computePorts, checkPort } from "../ports.js";
import { loadRepoConfig, resolveProjectPath } from "../config.js";
import { stopInstanceServices } from "../process.js";
import { regenerateAliases } from "../aliases.js";
import { groveContextEnv, type GroveSibling } from "../context.js";
import { runSequential, selectTargets, type TargetingOptions } from "../selection.js";
import type { GroveTarget } from "../target.js";

interface UprootOptions extends TargetingOptions {
  force?: boolean;
}

export async function uproot(targetOrProject: string | undefined, options: UprootOptions): Promise<void> {
  try {
    const selection = selectTargets(targetOrProject, options, process.cwd());
    if (selection.fanOut && !options.force) {
      throw new Error("uproot with a selector or --all requires --force");
    }
    process.exitCode = selection.fanOut
      ? await runSequential(selection.targets, (target) => uprootTarget(target, options))
      : await uprootTarget(selection.targets[0], options);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

export async function uprootTarget(target: GroveTarget, options: Pick<UprootOptions, "force">): Promise<number> {
  if (!target.instance) {
    throw new Error(`${target.projectName} is the project source; grove uproot needs a planted instance`);
  }
  const { project: proj, projectName: project, instance } = target;
  const instanceName = instance.name;
  const exists = fs.existsSync(instance.path);

  console.log(`Uprooting ${project}/${instanceName}`);
  console.log(`  Path: ${instance.path}${exists ? "" : " (already gone)"}`);
  console.log(`  Slot: ${instance.slot}`);

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
    console.log("  Ports:");
    for (const [svc, port] of Object.entries(ports)) {
      const up = await checkPort(port);
      console.log(`    ${svc}: ${port} ${up ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m"}`);
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
      throw new Error(`${project}/${instanceName} is no longer registered`);
    }
    const currentInstance = currentProject.instances[currentIndex];
    currentInstance.pending = "uprooting";
    delete currentInstance.reservationId;
    await saveRegistry(currentRegistry);
    return [
      { name: project, slot: 0, path: currentProject.source },
      ...currentProject.instances
        .filter((_, index) => index !== currentIndex)
        .map(({ name, slot, path }) => ({ name, slot, path })),
    ].sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  });

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

  try {
    console.log("\nStopping services...");
    const { killed, portsFreed } = await stopInstanceServices(instance.path, ports);
    if (killed > 0) {
      console.log(`  Killed ${killed} process${killed > 1 ? "es" : ""}.`);
    } else {
      console.log("  No running services found.");
    }
    if (!portsFreed) {
      console.log("\n\x1b[33m⚠\x1b[0m Some ports could not be freed. Continuing with teardown.");
    }

    if (teardownPath && teardownScript && contextEnv) {
      console.log(`\nRunning teardown script: ${teardownScript}`);
      try {
        execSync(`bash "${teardownPath}"`, {
          stdio: "inherit",
          cwd: instance.path,
          env: contextEnv,
        });
      } catch {
        console.error("  Warning: teardown script failed.");
      }
    }

    if (exists) {
      console.log(`\nRemoving ${instance.path}...`);
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
        throw new Error(`${project}/${instanceName} is no longer registered`);
      }
      currentProject.instances.splice(currentIndex, 1);
      await saveRegistry(currentRegistry);
      regenerateAliases(currentRegistry);
    });
  } catch (error) {
    throw new Error((error as Error).message);
  }

  console.log(`\nUprooted ${project}/${instanceName}.`);
  return 0;
}

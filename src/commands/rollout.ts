import { GROVE_CONFIG_FILE, loadRepoConfig } from "../config.js";
import { dispatchLifecycle } from "../lifecycle.js";
import { assertConfiguredRepositoriesClean, configuredRepositories, fastForwardConfiguredRepositories } from "../revisions.js";
import { runSequential, selectTargets, type TargetingOptions } from "../selection.js";
import { targetName, type GroveTarget } from "../target.js";
import { applyTarget } from "./apply.js";
import { reserveRevisionOperation } from "./revision-operation.js";

/** Move a selected fleet to every repository's configured branch and verify it starts. */
export async function rollout(project: string, options: TargetingOptions): Promise<void> {
  try {
    const selection = selectTargets(project, {
      ...options,
      // Rollout is fleet-forward by default; -l narrows that fleet.
      all: options.selector === undefined && !options.all ? true : options.all,
    }, process.cwd());
    process.exitCode = await runSequential(selection.targets, rolloutTarget);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

async function rolloutTarget(target: GroveTarget): Promise<number> {
  const preflight = sourceRepositories(target);
  assertConfiguredRepositoriesClean(preflight.repositories, "roll out");

  const reservation = await reserveRevisionOperation(target, "rolling-out");
  const { repositories, config } = sourceRepositories(reservation.target);
  // The first check precedes the reservation; this second short check closes
  // the gap before fetch changes any repository.
  assertConfiguredRepositoriesClean(repositories, "roll out");

  console.log(`Rolling out ${targetName(reservation.target)} (slot ${reservation.target.instance!.slot})`);
  fastForwardConfiguredRepositories(repositories);
  await applyTarget(reservation.target, {
    pendingOperation: { pending: reservation.pending, id: reservation.id },
    afterSetup: () => verifyLifecycle(reservation.target, config),
  });

  console.log(`Rolled out: ${targetName(reservation.target)}`);
  return 0;
}

function sourceRepositories(target: GroveTarget) {
  const config = loadRepoConfig(target.project.source, target.project.configFile ?? GROVE_CONFIG_FILE);
  return { config, repositories: configuredRepositories(target.root, config, "roll out") };
}

function verifyLifecycle(target: GroveTarget, config: ReturnType<typeof loadRepoConfig>): void {
  if (config?.lifecycle?.stop && config.lifecycle.start) {
    console.log("  Running lifecycle stop...");
    assertLifecycleExit(target, "stop");
    console.log("  Running lifecycle start...");
    assertLifecycleExit(target, "start");
  }
  if (config?.lifecycle?.status) {
    console.log("  Running lifecycle status...");
    assertLifecycleExit(target, "status");
  }
}

function assertLifecycleExit(target: GroveTarget, role: "start" | "stop" | "status"): void {
  const exitCode = dispatchLifecycle(target, role, "rolling-out");
  if (exitCode !== 0) {
    throw new Error(`${targetName(target)} lifecycle ${role} exited ${exitCode}`);
  }
}

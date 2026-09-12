import { GROVE_CONFIG_FILE, loadRepoConfig } from "../config.js";
import {
  assertConfiguredRepositoriesClean,
  configuredRepositories,
  discardConfiguredRepositoryChanges,
  fastForwardConfiguredRepositories,
} from "../revisions.js";
import { hasStateCommand, instanceContext, resetState } from "../state.js";
import { resolveTarget, targetName } from "../target.js";
import { applyTarget } from "./apply.js";
import { reserveRevisionOperation } from "./revision-operation.js";

interface ReleaseOptions {
  force?: boolean;
}

/** Return one claimed instance to its configured code, baseline state, and ready pool label. */
export async function release(targetRef: string, options: ReleaseOptions): Promise<void> {
  try {
    const target = resolveTarget({ at: targetRef, cwd: process.cwd() });
    if (!target) throw new Error(`no registered project contains ${process.cwd()}`);
    if (!target.instance) throw new Error(`${targetName(target)} is the project source; grove release needs a planted instance`);
    if (!hasStateCommand(target.project, instanceContext(target.project, target.projectName, target.instance.name))) {
      throw new Error(`cannot release ${targetName(target)}: no usable stateCommand is configured`);
    }

    const preflight = sourceRepositories(target);
    if (!options.force) assertConfiguredRepositoriesClean(preflight.repositories, "release", true);

    const reservation = await reserveRevisionOperation(target, "releasing");
    const { repositories } = sourceRepositories(reservation.target);
    if (options.force) {
      discardConfiguredRepositoryChanges(repositories, "release");
    } else {
      assertConfiguredRepositoriesClean(repositories, "release", true);
    }

    console.log(`Releasing ${targetName(reservation.target)} (slot ${reservation.target.instance!.slot})`);
    fastForwardConfiguredRepositories(repositories, "release");
    console.log("  Resetting state...");
    resetState(
      reservation.target.project,
      instanceContext(reservation.target.project, reservation.target.projectName, reservation.target.instance!.name),
    );
    await applyTarget(reservation.target, {
      pendingOperation: { pending: reservation.pending, id: reservation.id },
      complete: (instance) => {
        instance.spec.labels = { "grove.pool": "ready" };
      },
    });
    console.log(`Released: ${targetName(reservation.target)}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function sourceRepositories(target: NonNullable<ReturnType<typeof resolveTarget>>) {
  const config = loadRepoConfig(target.project.source, target.project.configFile ?? GROVE_CONFIG_FILE);
  return { repositories: configuredRepositories(target.root, config, "release") };
}

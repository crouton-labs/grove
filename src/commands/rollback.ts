import { GROVE_CONFIG_FILE, loadRepoConfig } from "../config.js";
import { currentApplied } from "../types.js";
import { assertConfiguredRepositoriesClean, checkoutPreviousRevision, configuredRepositories } from "../revisions.js";
import { resolveTarget, targetName } from "../target.js";
import { applyTarget } from "./apply.js";
import { completeRevisionOperation, reserveRevisionOperation } from "./revision-operation.js";

/** Restore one instance's configured repositories to its previous recorded revision. */
export async function rollback(targetRef: string): Promise<void> {
  try {
    const target = resolveTarget({ at: targetRef, cwd: process.cwd() });
    if (!target) throw new Error(`no registered project contains ${process.cwd()}`);
    if (!target.instance) throw new Error(`${targetName(target)} is the project source; grove rollback needs a planted instance`);

    const preflight = sourceRepositories(target);
    assertConfiguredRepositoriesClean(preflight.repositories, "roll back");
    assertRollbackHistory(target);

    const reservation = await reserveRevisionOperation(target, "rolling-back");
    const { repositories } = sourceRepositories(reservation.target);
    const { current, previous } = assertRollbackHistory(reservation.target);
    assertConfiguredRepositoriesClean(repositories, "roll back");

    console.log(`Rolling back ${targetName(reservation.target)} (slot ${reservation.target.instance!.slot})`);
    checkoutPreviousRevision(repositories, previous);
    await applyTarget(reservation.target, {
      pendingOperation: { pending: reservation.pending, id: reservation.id },
      rolledBackFrom: current.at,
    });
    await completeRevisionOperation(reservation);
    console.log(`Rolled back: ${targetName(reservation.target)}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function sourceRepositories(target: NonNullable<ReturnType<typeof resolveTarget>>) {
  const config = loadRepoConfig(target.project.source, target.project.configFile ?? GROVE_CONFIG_FILE);
  return { repositories: configuredRepositories(target.root, config, "roll back") };
}

function assertRollbackHistory(target: NonNullable<ReturnType<typeof resolveTarget>>) {
  const instance = target.instance!;
  const current = currentApplied(instance);
  const previous = instance.history[1];
  if (!current || !previous) {
    throw new Error(`${targetName(target)} has only ${instance.history.length} recorded revision${instance.history.length === 1 ? "" : "s"}; rollback needs at least two`);
  }
  return { current, previous };
}

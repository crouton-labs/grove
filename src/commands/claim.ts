import { loadRepoConfig } from "../config.js";
import { dispatchLifecycle } from "../lifecycle.js";
import { printGroveOutput, type GroveOutput } from "../plant-output.js";
import { computePorts } from "../ports.js";
import { saveRegistry, withRegistryLock } from "../registry.js";
import { parseLabelAssignments } from "../selection.js";
import { describeRecordedRepos } from "../setup.js";
import { hasStateCommand, instanceContext } from "../state.js";
import { resolveTargetFromRef, type GroveTarget } from "../target.js";
import { currentApplied } from "../types.js";
import { finishTarget, verifyClaimFreshness } from "./finish.js";
import { plant } from "./plant.js";
import { isPoolReady } from "./pool.js";

interface ClaimOptions {
  label?: string[];
}

/** Atomically take a pool row, then hand it over only if it is fresh and ready. */
export async function claim(projectName: string, options: ClaimOptions): Promise<void> {
  try {
    const labels = parseLabelAssignments(options.label ?? []);
    const summary = await withRegistryLock(async (registry): Promise<GroveOutput> => {
      const project = registry.projects[projectName];
      if (!project) throw new Error(`project "${projectName}" not registered`);
      const instance = project.instances
        .filter(isPoolReady)
        .sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name))[0];
      if (!instance) {
        throw new Error(`no ready instance in pool "${projectName}"; create one with: grove pool ${projectName} --size 1`);
      }
      Object.assign(instance.spec.labels, labels);
      delete instance.spec.labels["grove.pool"];
      const applied = currentApplied(instance);
      const context = instanceContext(project, projectName, instance.name);
      const claimed: GroveOutput = {
        project: projectName,
        instance: instance.name,
        slot: instance.slot,
        source: project.source,
        target: instance.path,
        ports: computePorts(project.ports, instance.slot),
        from: hasStateCommand(project, context) ? instance.spec.from : null,
        code: applied?.code ? { mode: instance.spec.codeFrom, repos: describeRecordedRepos(instance.path, applied.code) } : null,
        spec: instance.spec,
        applied,
      };
      await saveRegistry(registry);
      return claimed;
    });

    const target = resolveTargetFromRef(`${projectName}/${summary.instance}`);
    const reasons = await verifyReady(target);
    if (!reasons.length) {
      console.log(`Claimed from pool: ${projectName}/${summary.instance}`);
      console.log("");
      printGroveOutput(summary);
      return;
    }

    console.log(`Pool instance ${projectName}/${summary.instance} needs replacement: ${reasons.join("; ")}`);
    const finished = await finishTarget(target);
    if (!finished.finished) {
      console.log(`Kept ${finished.instance}: finish refused (${finished.reason}).`);
    }

    const labelArgs = Object.entries(summary.spec.labels).map(([key, value]) => `${key}=${value}`);
    const replanted = await plant(projectName, undefined, { label: labelArgs, quiet: true });
    const replacement = resolveTargetFromRef(`${projectName}/${replanted.instance}`);
    const replacementReasons = await verifyReady(replacement);
    if (replacementReasons.length) {
      throw new Error(`replanted ${projectName}/${replanted.instance} is not ready: ${replacementReasons.join("; ")}`);
    }
    console.log(`Replanted: ${projectName}/${replanted.instance} because ${reasons.join("; ")}`);
    console.log("");
    printGroveOutput(replanted);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

async function verifyReady(target: GroveTarget): Promise<string[]> {
  const reasons = await verifyClaimFreshness(target);
  const sourceConfig = loadRepoConfig(target.project.source, target.project.configFile);
  if (sourceConfig?.lifecycle?.status) {
    const status = dispatchLifecycle(target, "status");
    if (status !== 0) reasons.push(`lifecycle status exited ${status}`);
  }
  return reasons;
}

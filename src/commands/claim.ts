import { printGroveOutput, type GroveOutput } from "../plant-output.js";
import { computePorts } from "../ports.js";
import { saveRegistry, withRegistryLock } from "../registry.js";
import { parseLabelAssignments } from "../selection.js";
import { describeRecordedRepos } from "../setup.js";
import { hasStateCommand, instanceContext } from "../state.js";
import { currentApplied } from "../types.js";

interface ClaimOptions {
  label?: string[];
}

export async function claim(projectName: string, options: ClaimOptions): Promise<void> {
  try {
    const labels = parseLabelAssignments(options.label ?? []);
    const summary = await withRegistryLock(async (registry): Promise<GroveOutput> => {
      const project = registry.projects[projectName];
      if (!project) throw new Error(`project "${projectName}" not registered`);
      const instance = project.instances
        .filter((candidate) => candidate.spec.labels["grove.pool"] === "ready" && !candidate.pending && !candidate.needsState)
        .sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name))[0];
      if (!instance) {
        throw new Error(`no ready instance in pool "${projectName}"; create one with: grove pool ${projectName} --size 1`);
      }
      Object.assign(instance.spec.labels, labels);
      delete instance.spec.labels["grove.pool"];
      const applied = currentApplied(instance);
      const context = instanceContext(project, projectName, instance.name);
      const summary: GroveOutput = {
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
      return summary;
    });

    console.log(`Claimed: ${projectName}/${summary.instance}`);
    console.log("");
    printGroveOutput(summary);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

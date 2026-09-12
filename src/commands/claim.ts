import { GROVE_CONFIG_FILE, loadRepoConfig } from "../config.js";
import { printGroveOutput } from "../plant-output.js";
import { computePorts } from "../ports.js";
import { saveRegistry, withRegistryLock } from "../registry.js";
import { parseLabelAssignments } from "../selection.js";
import { describeClonedRepos } from "../setup.js";
import { hasStateCommand, instanceContext } from "../state.js";
import { currentApplied } from "../types.js";

interface ClaimOptions {
  label?: string[];
}

export async function claim(projectName: string, options: ClaimOptions): Promise<void> {
  try {
    const labels = parseLabelAssignments(options.label ?? []);
    const claimed = await withRegistryLock(async (registry) => {
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
      await saveRegistry(registry);
      return { project, instance };
    });

    const config = loadRepoConfig(claimed.project.source, claimed.project.configFile ?? GROVE_CONFIG_FILE);
    const context = instanceContext(claimed.project, projectName, claimed.instance.name);
    console.log(`Claimed: ${projectName}/${claimed.instance.name}`);
    console.log("");
    printGroveOutput({
      project: projectName,
      instance: claimed.instance.name,
      slot: claimed.instance.slot,
      source: claimed.project.source,
      target: claimed.instance.path,
      ports: computePorts(claimed.project.ports, claimed.instance.slot),
      from: hasStateCommand(claimed.project, context) ? claimed.instance.spec.from : null,
      code: config?.repos
        ? { mode: claimed.instance.spec.codeFrom, repos: describeClonedRepos(claimed.instance.path, config.repos) }
        : null,
      spec: claimed.instance.spec,
      applied: currentApplied(claimed.instance),
    });
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

import { loadRegistry } from "./registry.js";
import { resolveTarget, targetName, type GroveTarget } from "./target.js";
import type { GroveRegistry } from "./types.js";

const LABEL_KEY = /^[a-z0-9._-]+$/;

export interface TargetingOptions {
  selector?: string;
  all?: boolean;
}

export interface TargetSelection {
  targets: GroveTarget[];
  fanOut: boolean;
}

export interface SequentialTargetResult {
  target: GroveTarget;
  status: "succeeded" | "failed" | "not-started";
  exitCode?: number;
}

export function parseLabelAssignments(assignments: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const key = separator === -1 ? "" : assignment.slice(0, separator);
    const value = separator === -1 ? "" : assignment.slice(separator + 1);
    assertLabelKey(key, `label "${assignment}"`);
    if (!value || value.includes(",")) {
      throw new Error(`invalid label "${assignment}" — use key=value with a non-empty value that does not contain a comma`);
    }
    if (Object.hasOwn(labels, key)) {
      throw new Error(`label key "${key}" was given more than once`);
    }
    labels[key] = value;
  }
  return labels;
}

export function parseSelector(selector: string): Record<string, string> {
  if (!selector) throw new Error("selector must contain at least one key=value pair");
  try {
    return parseLabelAssignments(selector.split(","));
  } catch (error) {
    throw new Error(`invalid selector "${selector}" — ${(error as Error).message}`);
  }
}

export function assertLabelKey(key: string, subject = `label key "${key}"`): void {
  if (!LABEL_KEY.test(key)) {
    throw new Error(`invalid ${subject} — keys must match [a-z0-9._-]+`);
  }
}

/** Resolve one explicit target, or a source-excluding selector/all target set. */
export function selectTargets(
  targetOrProject: string | undefined,
  options: TargetingOptions,
  cwd: string,
): TargetSelection {
  const hasSelector = options.selector !== undefined;
  const hasAll = options.all === true;
  if (hasSelector && hasAll) throw new Error("use either -l/--selector or --all, not both");

  if (!hasSelector && !hasAll) {
    if (!targetOrProject) throw new Error("specify a target, a label selector (-l key=value), or --all");
    const target = resolveTarget({ at: targetOrProject, cwd });
    if (!target) throw new Error(`no registered project contains ${cwd}`);
    return { targets: [target], fanOut: false };
  }

  const registry = loadRegistry();
  const projectName = resolveSelectionProject(targetOrProject, cwd, registry.projects);
  const project = registry.projects[projectName];
  if (!project) throw new Error(`project "${projectName}" not registered`);

  const selector = hasSelector ? parseSelector(options.selector!) : undefined;
  const targets = project.instances
    .filter((instance) => !selector || Object.entries(selector).every(([key, value]) => instance.spec.labels[key] === value))
    .sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name))
    .map((instance) => ({ project, projectName, root: instance.path, instance }));
  if (!targets.length) {
    if (selector) throw new Error(`selector "${options.selector}" matched no instances in project "${projectName}"`);
    throw new Error(`--all matched no instances in project "${projectName}"`);
  }
  return { targets, fanOut: true };
}

/** Run targets in order, stop after the first failure, and print their final state. */
/** Find the same registered instance after a fan-out wait or before a mutation. */
export function currentRegisteredTarget(registry: GroveRegistry, target: GroveTarget): GroveTarget {
  if (!target.instance) return target;
  const project = registry.projects[target.projectName];
  const instance = project?.instances.find((candidate) =>
    candidate.name === target.instance!.name &&
    candidate.slot === target.instance!.slot &&
    candidate.path === target.instance!.path &&
    candidate.created === target.instance!.created,
  );
  if (!project || !instance) throw new Error(`${targetName(target)} is no longer registered`);
  return { project, projectName: target.projectName, root: instance.path, instance };
}

export async function runSequential(
  targets: readonly GroveTarget[], 
  action: (target: GroveTarget) => number | Promise<number>,
): Promise<number> {
  const results: SequentialTargetResult[] = [];
  let failure: GroveTarget | undefined;

  for (const target of targets) {
    if (failure) {
      results.push({ target, status: "not-started" });
      continue;
    }
    try {
      const exitCode = await action(target);
      if (exitCode === 0) {
        results.push({ target, status: "succeeded", exitCode });
      } else {
        results.push({ target, status: "failed", exitCode });
        failure = target;
      }
    } catch (error) {
      console.error(`Error: ${targetName(target)}: ${(error as Error).message}`);
      results.push({ target, status: "failed", exitCode: 1 });
      failure = target;
    }
  }

  console.log("\nSummary:");
  for (const result of results) {
    const name = targetName(result.target);
    if (result.status === "succeeded") console.log(`  ${name}: succeeded`);
    else if (result.status === "failed") console.log(`  ${name}: failed (exit ${result.exitCode})`);
    else console.log(`  ${name}: not started (stopped after ${targetName(failure!)} failed)`);
  }
  return failure ? 1 : 0;
}

function resolveSelectionProject(
  projectArgument: string | undefined,
  cwd: string,
  projects: Record<string, unknown>,
): string {
  if (projectArgument) {
    if (projectArgument.includes("/")) {
      throw new Error(`selectors take an optional project name, not target "${projectArgument}"`);
    }
    return projectArgument;
  }
  const fromCwd = resolveTarget({ cwd });
  if (fromCwd) return fromCwd.projectName;
  const names = Object.keys(projects);
  if (names.length === 1) return names[0];
  throw new Error("selectors need a project when the current directory is not in a registered project");
}

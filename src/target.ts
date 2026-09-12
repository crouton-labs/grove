import fs from "fs";
import path from "path";
import { isWithinRoot } from "./config.js";
import { loadRegistry } from "./registry.js";
import { parseInstanceRef, pendingError, stateNotAppliedError } from "./state.js";
import type { GroveInstance, GroveProjectConfig } from "./types.js";

export interface GroveTarget {
  project: GroveProjectConfig;
  projectName: string;
  root: string;
  instance?: GroveInstance;
}

export class TargetNotFoundError extends Error {}

export function targetName(target: GroveTarget): string {
  return target.instance ? `${target.projectName}/${target.instance.name}` : target.projectName;
}

export function targetSlot(target: GroveTarget): number {
  return target.instance?.slot ?? 0;
}

export function resolveTarget({ at, cwd }: { at?: string; cwd: string }): GroveTarget | undefined {
  return at === undefined ? resolveTargetFromCwd(cwd) : resolveTargetFromRef(at);
}

export function resolveTargetFromCwd(cwd: string): GroveTarget | undefined {
  const registry = loadRegistry();
  const resolvedCwd = fs.realpathSync(cwd);
  const candidates: Array<GroveTarget & { rootLength: number }> = [];

  for (const [projectName, project] of Object.entries(registry.projects)) {
    addCandidate(candidates, resolvedCwd, project, projectName, project.source);
    for (const instance of project.instances) {
      addCandidate(candidates, resolvedCwd, project, projectName, instance.path, instance);
    }
  }

  candidates.sort((a, b) => b.rootLength - a.rootLength);
  return candidates[0];
}

export function resolveTargetFromRef(ref: string): GroveTarget {
  const registry = loadRegistry();
  if (!ref.includes("/")) {
    const project = registry.projects[ref];
    if (!project) throw unknownProject(ref, registry.projects);
    return { project, projectName: ref, root: path.resolve(project.source) };
  }

  const [projectName, instanceRef] = parseInstanceRef(ref);
  const project = registry.projects[projectName];
  if (!project) throw unknownProject(projectName, registry.projects);
  if (instanceRef === "0") {
    return { project, projectName, root: path.resolve(project.source) };
  }

  const byName = project.instances.find((instance) => instance.name === instanceRef);
  const bySlot = /^\d+$/.test(instanceRef)
    ? project.instances.find((instance) => instance.slot === Number(instanceRef))
    : undefined;
  if (byName && bySlot && byName !== bySlot) {
    throw new Error(`instance reference "${ref}" is ambiguous: "${instanceRef}" names ${projectName}/${byName.name} but slot ${instanceRef} is ${projectName}/${bySlot.name}. Use the unambiguous name.`);
  }
  const instance = byName ?? bySlot;
  if (!instance) {
    const known = project.instances
      .map((candidate) => `${projectName}/${candidate.name} (slot ${candidate.slot})`)
      .join(", ");
    throw new TargetNotFoundError(
      `instance "${instanceRef}" not found in project "${projectName}"${known ? `. Instances: ${known}` : ""}`,
    );
  }
  return { project, projectName, root: path.resolve(instance.path), instance };
}

export function assertTargetUsable(target: GroveTarget): void {
  if (target.instance?.pending) {
    throw new Error(pendingError(target.projectName, target.instance));
  }
  if (target.instance?.needsState) {
    throw new Error(stateNotAppliedError(target.projectName, target.instance));
  }
  if (!fs.existsSync(target.root)) {
    throw new Error(`target directory does not exist: ${target.root} — run grove doctor`);
  }
}


function unknownProject(projectName: string, projects: Record<string, GroveProjectConfig>): TargetNotFoundError {
  const names = Object.keys(projects);
  return new TargetNotFoundError(
    `project "${projectName}" not registered.${names.length ? ` Registered projects: ${names.join(", ")}` : " No projects registered. Run: grove register <path>"}`,
  );
}

function addCandidate(
  candidates: Array<GroveTarget & { rootLength: number }>,
  cwd: string,
  project: GroveProjectConfig,
  projectName: string,
  rootPath: string,
  instance?: GroveInstance,
): void {
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(rootPath);
  } catch {
    return;
  }
  if (!isWithinRoot(resolvedRoot, cwd)) return;
  candidates.push({ project, projectName, root: path.resolve(rootPath), instance, rootLength: resolvedRoot.length });
}

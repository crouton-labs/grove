import fs from "fs";
import path from "path";
import { isWithinRoot } from "./config.js";
import { loadCurrent } from "./current.js";
import { loadRegistry } from "./registry.js";
import { parseInstanceRef, pendingError, stateNotAppliedError } from "./state.js";
import type { GroveInstance, GroveProjectConfig } from "./types.js";

export interface GroveTarget {
  project: GroveProjectConfig;
  projectName: string;
  root: string;
  instance?: GroveInstance;
}

export type TargetSource = "target" | "--instance" | "GROVE_INSTANCE" | "current directory" | "grove use";

export interface ResolvedTarget {
  target: GroveTarget;
  source: TargetSource;
}

export class TargetNotFoundError extends Error {}
export class TargetUsageError extends Error {}

export function targetErrorExitCode(error: unknown): number {
  if (error instanceof TargetUsageError) return 2;
  if (error instanceof TargetNotFoundError) return 4;
  return 1;
}

export function targetName(target: GroveTarget): string {
  return target.instance ? `${target.projectName}/${target.instance.name}` : target.projectName;
}

export function targetSlot(target: GroveTarget): number {
  return target.instance?.slot ?? 0;
}

/** Resolve a command target in the one documented G4 order. */
export function resolveCommandTarget({
  target,
  instance,
  cwd,
  stdinIsTTY = process.stdin.isTTY === true,
}: {
  target?: string;
  instance?: string;
  cwd: string;
  stdinIsTTY?: boolean;
}): ResolvedTarget {
  if (target && instance) throw new TargetUsageError("name the target once; use either [target] or --instance <target>");
  if (target) return { target: resolveTargetFromRef(target), source: "target" };
  if (instance) return { target: resolveTargetFromRef(instance), source: "--instance" };
  if (process.env.GROVE_INSTANCE) return { target: resolveTargetFromRef(process.env.GROVE_INSTANCE), source: "GROVE_INSTANCE" };
  const fromCwd = resolveTargetFromCwd(cwd);
  if (fromCwd) return { target: fromCwd, source: "current directory" };
  if (stdinIsTTY) {
    const current = loadCurrent();
    if (current) return { target: resolveTargetFromRef(current), source: "grove use" };
  }
  throw new TargetUsageError("no instance target resolved; pass --instance <target>");
}

/** Print the required G4 line from the one shared rendering function. */
export function printResolvedTarget({ target, source }: ResolvedTarget): void {
  console.log(`Instance: ${targetName(target)} (${source})`);
}

/** Legacy lower-level resolver retained for non-command callers. */
export function resolveTarget({ at, cwd }: { at?: string; cwd: string }): GroveTarget | undefined {
  return at === undefined ? resolveTargetFromCwd(cwd) : resolveTargetFromRef(at);
}

export function resolveTargetFromCwd(cwd: string): GroveTarget | undefined {
  const registry = loadRegistry();
  let resolvedCwd: string;
  try {
    resolvedCwd = fs.realpathSync(cwd);
  } catch {
    return undefined;
  }
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

  const byName = project.instances.find((candidate) => candidate.name === instanceRef);
  const bySlot = /^\d+$/.test(instanceRef)
    ? project.instances.find((candidate) => candidate.slot === Number(instanceRef))
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

export function assertTargetUsable(target: GroveTarget, allowedPending?: GroveInstance["pending"]): void {
  if (target.instance?.pending && target.instance.pending !== allowedPending) {
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

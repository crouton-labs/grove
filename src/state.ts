import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { GROVE_DIR } from "./registry.js";
import { GROVE_CONFIG_FILE, loadRepoConfig, resolveStateCommand } from "./config.js";
import { groveContextEnv, GroveExecutionContext } from "./context.js";
import { computePorts } from "./ports.js";
import type { GroveInstance, GroveProjectConfig } from "./types.js";

export const STATES_DIR = path.join(GROVE_DIR, "states");
export const BASELINE_REF = "baseline";

/** Snapshot names become directory names — keep them to one harmless segment. */
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SnapshotMeta {
  name: string;
  project: string;
  /** Instance the snapshot was captured from, for provenance only. */
  instance: string;
  slot: number;
  /** Schema generation reported by `stateCommand fingerprint`, when it produced one. */
  fingerprint: string | null;
  created: string;
  bytes: number;
}

export type StateRef =
  | { kind: "baseline" }
  | { kind: "live"; label: string; context: GroveExecutionContext }
  | { kind: "snapshot"; name: string; dir: string; meta: SnapshotMeta };

// ---------------------------------------------------------------------------
// Execution contexts
// ---------------------------------------------------------------------------

/** Split a `project/instance` argument, erroring with the expected shape. */
export function parseInstanceRef(ref: string): [string, string] {
  const parts = ref.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`specify the instance as project/name (e.g. "northlight/2"), got "${ref}"`);
  }
  return [parts[0], parts[1]];
}

/** Context for the project source, which grove treats as slot 0. */
export function sourceContext(
  project: GroveProjectConfig,
  projectName: string,
): GroveExecutionContext {
  return {
    source: project.source,
    target: project.source,
    slot: 0,
    instanceName: projectName,
    ports: computePorts(project.ports, 0),
  };
}

/** Look up a registered instance, throwing with the instance list when unknown. */
export function findInstance(
  project: GroveProjectConfig,
  projectName: string,
  instanceName: string,
): GroveInstance {
  const instance = project.instances.find((i) => i.name === instanceName);
  if (!instance) {
    const known = project.instances.map((i) => `${projectName}/${i.name}`).join(", ");
    throw new Error(
      `instance "${instanceName}" not found in project "${projectName}"` +
        (known ? `. Instances: ${known}` : ""),
    );
  }
  return instance;
}

/**
 * Why an instance carrying `needsState` must not be used yet, and the one
 * command that repairs it.
 */
export function stateNotAppliedError(
  projectName: string,
  instance: GroveInstance,
): string {
  return (
    `${projectName}/${instance.name} was planted but its state was never applied. ` +
    `Repair it with: grove restore ${projectName}/${instance.name} ${instance.needsState}` +
    ` (or remove it with: grove uproot ${projectName}/${instance.name})`
  );
}

/** Context for a registered instance, by name. Throws with the instance list when unknown. */
export function instanceContext(
  project: GroveProjectConfig,
  projectName: string,
  instanceName: string,
): GroveExecutionContext {
  const instance = findInstance(project, projectName, instanceName);
  return {
    source: project.source,
    target: instance.path,
    slot: instance.slot,
    instanceName: instance.name,
    ports: computePorts(project.ports, instance.slot),
  };
}

// ---------------------------------------------------------------------------
// stateCommand dispatch
// ---------------------------------------------------------------------------

function stateCommandFor(
  project: GroveProjectConfig,
  context: GroveExecutionContext,
): string {
  const config = loadRepoConfig(context.target, project.configFile ?? GROVE_CONFIG_FILE);
  if (!config?.stateCommand) {
    throw new Error(
      `no stateCommand configured for ${context.target} — add one to ${project.configFile ?? GROVE_CONFIG_FILE} to use grove's state commands`,
    );
  }
  return resolveStateCommand(context.target, config.stateCommand);
}

/** Whether a root has a usable stateCommand, without throwing when it does not. */
export function hasStateCommand(
  project: GroveProjectConfig,
  context: GroveExecutionContext,
): boolean {
  try {
    stateCommandFor(project, context);
    return true;
  } catch {
    return false;
  }
}

function runVerb(
  project: GroveProjectConfig,
  context: GroveExecutionContext,
  verb: string,
  args: string[],
  captureStdout = false,
): string {
  const command = stateCommandFor(project, context);
  const result = spawnSync(command, [verb, ...args], {
    cwd: context.target,
    env: groveContextEnv(context),
    stdio: captureStdout ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf-8",
  });

  if (result.error) {
    throw new Error(`stateCommand ${verb} failed to run: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`stateCommand ${verb} killed by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`stateCommand ${verb} exited with status ${result.status}`);
  }
  return captureStdout ? (result.stdout ?? "").trim() : "";
}

export function resetState(project: GroveProjectConfig, context: GroveExecutionContext): void {
  runVerb(project, context, "reset", []);
}

export function captureInto(
  project: GroveProjectConfig,
  context: GroveExecutionContext,
  dir: string,
): void {
  fs.mkdirSync(dir, { recursive: true });
  runVerb(project, context, "capture", [dir]);
}

export function restoreFrom(
  project: GroveProjectConfig,
  context: GroveExecutionContext,
  dir: string,
): void {
  runVerb(project, context, "restore", [dir]);
}

export function fingerprintOf(
  project: GroveProjectConfig,
  context: GroveExecutionContext,
): string {
  return runVerb(project, context, "fingerprint", [], true);
}

/** Fingerprint, or null when the project cannot produce one right now. */
export function tryFingerprint(
  project: GroveProjectConfig,
  context: GroveExecutionContext,
): string | null {
  try {
    const value = fingerprintOf(project, context);
    return value || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot store
// ---------------------------------------------------------------------------

export function projectStatesDir(projectName: string): string {
  return path.join(STATES_DIR, projectName);
}

export function snapshotDir(projectName: string, name: string): string {
  assertSnapshotName(name);
  return path.join(projectStatesDir(projectName), name);
}

export function assertSnapshotName(name: string): void {
  if (!SNAPSHOT_NAME_RE.test(name)) {
    throw new Error(
      `invalid snapshot name "${name}" — use letters, digits, dot, dash, underscore`,
    );
  }
  if (name === BASELINE_REF) {
    throw new Error(`"${BASELINE_REF}" is a reserved ref and cannot name a snapshot`);
  }
}

function readMeta(dir: string): SnapshotMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")) as SnapshotMeta;
  } catch {
    return null;
  }
}

export function listSnapshots(projectName: string): SnapshotMeta[] {
  const dir = projectStatesDir(projectName);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readMeta(path.join(dir, e.name)))
    .filter((m): m is SnapshotMeta => m !== null)
    .sort((a, b) => a.created.localeCompare(b.created));
}

export function removeSnapshot(projectName: string, name: string): boolean {
  const dir = snapshotDir(projectName, name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // raced away between readdir and stat — not worth failing a capture over
      }
    }
  }
  return total;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

/** Capture an instance's state into the store under `name`. */
export function writeSnapshot(
  projectName: string,
  project: GroveProjectConfig,
  context: GroveExecutionContext,
  name: string,
  overwrite: boolean,
): SnapshotMeta {
  const dir = snapshotDir(projectName, name);
  if (fs.existsSync(dir)) {
    if (!overwrite) {
      throw new Error(`snapshot "${name}" already exists — pass --force to replace it`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    captureInto(project, context, dataDir);
  } catch (error) {
    // A half-written snapshot is worse than none: it would restore silently.
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  const meta: SnapshotMeta = {
    name,
    project: projectName,
    instance: context.instanceName,
    slot: context.slot,
    fingerprint: tryFingerprint(project, context),
    created: new Date().toISOString(),
    bytes: dirSize(dataDir),
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/**
 * Resolve a ref for a project. Grammar:
 *   baseline      the project's own empty/migrated baseline
 *   @<instance>   live capture from that instance; @source means the project source
 *   <name>        a stored snapshot
 */
export function resolveRef(
  projectName: string,
  project: GroveProjectConfig,
  ref: string,
): StateRef {
  if (ref === BASELINE_REF) return { kind: "baseline" };

  if (ref.startsWith("@")) {
    const target = ref.slice(1);
    if (!target) throw new Error('a live ref needs an instance name, e.g. "@source" or "@2"');
    if (target === "source") {
      return { kind: "live", label: "@source", context: sourceContext(project, projectName) };
    }
    return {
      kind: "live",
      label: `@${target}`,
      context: instanceContext(project, projectName, target),
    };
  }

  assertSnapshotName(ref);
  const dir = snapshotDir(projectName, ref);
  const meta = readMeta(dir);
  if (!meta) {
    const known = listSnapshots(projectName).map((m) => m.name);
    throw new Error(
      `no snapshot "${ref}" for project "${projectName}"` +
        (known.length ? `. Snapshots: ${known.join(", ")}` : ". No snapshots stored yet"),
    );
  }
  return { kind: "snapshot", name: ref, dir, meta };
}

export function describeRef(ref: StateRef): string {
  switch (ref.kind) {
    case "baseline":
      return "baseline";
    case "live":
      return `live capture from ${ref.label}`;
    case "snapshot":
      return `snapshot "${ref.name}" (${formatBytes(ref.meta.bytes)}, captured ${ref.meta.created})`;
  }
}

/**
 * Refuse a restore whose captured schema generation differs from the
 * destination's. A null on either side means one end could not report a
 * fingerprint, which is not evidence of a mismatch — let it through.
 */
function gateFingerprint(
  project: GroveProjectConfig,
  dest: GroveExecutionContext,
  expected: string | null,
  ignoreFingerprint: boolean,
): void {
  if (expected === null) return;
  const actual = tryFingerprint(project, dest);
  if (actual === null || actual === expected) return;

  const detail = `captured at "${expected}", destination is at "${actual}"`;
  if (ignoreFingerprint) {
    console.log(
      `  \x1b[33m⚠\x1b[0m Fingerprint mismatch (${detail}) — proceeding under --ignore-fingerprint`,
    );
    return;
  }
  throw new Error(
    `fingerprint mismatch: ${detail}. The captured state does not match this checkout's schema. ` +
      `Re-capture it, or pass --ignore-fingerprint to restore anyway.`,
  );
}

/**
 * Bring `dest` to the state named by `ref`. `ignoreFingerprint` is deliberately
 * separate from any confirmation flag: a scripted `--force` must not silently
 * disable the one check standing between a stale dump and a corrupt database.
 */
export function applyRef(
  project: GroveProjectConfig,
  ref: StateRef,
  dest: GroveExecutionContext,
  ignoreFingerprint: boolean,
): void {
  if (ref.kind === "baseline") {
    resetState(project, dest);
    return;
  }

  if (ref.kind === "snapshot") {
    gateFingerprint(project, dest, ref.meta.fingerprint, ignoreFingerprint);
    restoreFrom(project, dest, path.join(ref.dir, "data"));
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grove-state-"));
  try {
    captureInto(project, ref.context, tmp);
    gateFingerprint(project, dest, tryFingerprint(project, ref.context), ignoreFingerprint);
    restoreFrom(project, dest, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

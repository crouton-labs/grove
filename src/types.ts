export interface PortDef {
  base: number;
  offset: number; // actual = base + slot * offset
}

export interface GroveInstanceSpec {
  codeFrom: "configured" | "@source";
  from: string;
  labels: Record<string, string>;
}

export interface GroveApplied {
  configHash: string;
  at: string;
  code: Record<string, { branch: string | null; commit: string }> | null;
  rolledBackFrom?: string;
}

export interface GrovePendingOperation {
  id: string;
  pid: number;
  restore?: {
    target: string;
    ref: string;
    source?: string;
  };
}

export interface GroveInstance {
  name: string;
  path: string;
  slot: number;
  created: string;
  /**
   * The state ref plant registered but has not applied. Present only while an
   * instance exists without its data state; a successful restore clears it.
   */
  needsState?: string;
  /** Present while an operation has reserved this instance's slot. */
  pending?: "planting" | "uprooting" | "applying" | "restoring" | "rolling-out" | "rolling-back";
  /** Identifies the specific plant attempt that owns a pending reservation. */
  reservationId?: string;
  /** Identifies the process and restore request that own an apply or restore reservation. */
  pendingOperation?: GrovePendingOperation;
  spec: GroveInstanceSpec;
  /** Newest first; retained revisions are capped at ten. */
  history: GroveApplied[];
}

/** Return an instance's newest recorded revision. */
export function currentApplied(instance: Pick<GroveInstance, "history"> | undefined): GroveApplied | null {
  return instance?.history[0] ?? null;
}

/** Add a revision while retaining the ten newest records. */
export function recordApplied(instance: GroveInstance, applied: GroveApplied): void {
  instance.history.unshift(applied);
  instance.history.splice(10);
}

export interface GroveProjectConfig {
  source: string;
  configFile?: string;
  initScript?: string;
  teardownScript?: string;
  ports: Record<string, PortDef>;
  instances: GroveInstance[];
  // Shell-alias scheme: { aliasPrefix: subdir-relative-to-instance }.
  // e.g. { "cr": ".", "cn": "northlight", "cv": "northlight-vault" }
  // generates `alias cr<slot>='cd <instance>'`, etc.
  aliases?: Record<string, string>;
}

export interface GroveRegistry {
  version: 2;
  projects: Record<string, GroveProjectConfig>;
}

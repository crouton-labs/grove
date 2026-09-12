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
  /** Present while plant has reserved this slot but has not completed. */
  pending?: "planting";
  /** Identifies the specific plant attempt that owns a pending reservation. */
  reservationId?: string;
  spec: GroveInstanceSpec;
  applied: GroveApplied | null;
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

export interface PortDef {
  base: number;
  offset: number; // actual = base + slot * offset
}

export interface GroveInstance {
  name: string;
  path: string;
  slot: number;
  created: string;
}

export interface GroveProjectConfig {
  source: string;
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
  projects: Record<string, GroveProjectConfig>;
}

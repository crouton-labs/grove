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
}

export interface GroveRegistry {
  projects: Record<string, GroveProjectConfig>;
}

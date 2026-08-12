export interface GroveExecutionContext {
  source: string;
  target: string;
  slot: number;
  instanceName: string;
  ports: Record<string, number>;
}

/** Build the environment shared by Grove setup, teardown, and dev dispatch. */
export function groveContextEnv(
  context: GroveExecutionContext,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GROVE_SLOT: String(context.slot),
    GROVE_SOURCE: context.source,
    GROVE_TARGET: context.target,
    GROVE_INSTANCE_NAME: context.instanceName,
    GROVE_PORTS_JSON: JSON.stringify(context.ports),
  };
  for (const [portName, portValue] of Object.entries(context.ports)) {
    env[`GROVE_PORT_${portName.toUpperCase().replace(/-/g, "_")}`] = String(portValue);
  }
  return env;
}


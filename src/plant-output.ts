import type { GroveApplied, GroveInstanceSpec } from "./types.js";

export interface GroveOutput {
  project: string;
  instance: string;
  slot: number;
  source: string;
  target: string;
  ports: Record<string, number>;
  from: string | null;
  code: { mode: GroveInstanceSpec["codeFrom"]; repos: Record<string, { branch: string | null; sha: string }> } | null;
  spec: GroveInstanceSpec;
  applied: GroveApplied | null;
}

/** Print the machine-readable instance summary consumed by Grove callers. */
export function printGroveOutput(summary: GroveOutput): void {
  console.log("--- grove-output ---");
  console.log(JSON.stringify(summary, null, 2));
}

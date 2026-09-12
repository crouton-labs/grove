import { createHash } from "crypto";
import type { GroveRepoConfig } from "./config.js";

/** JSON with object keys sorted recursively; arrays retain their declared order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** The validated source config is the intent Grove compares and records. */
export function configHash(config: GroveRepoConfig | null): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

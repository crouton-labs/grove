import { loadRegistry } from "../registry.js";
import type { GroveInstance } from "../types.js";
import { plant } from "./plant.js";

interface PoolOptions {
  size?: string;
}

export async function pool(projectName: string, options: PoolOptions): Promise<void> {
  try {
    const size = options.size === undefined ? undefined : parseSize(options.size);
    if (size === undefined) {
      printPoolStatus(projectName);
      return;
    }

    const initial = poolStatus(projectName);
    if (initial.ready.length >= size) {
      console.log(`Pool ${projectName} already has ${initial.ready.length} ready instance(s); requested ${size}. Nothing to do.`);
      return;
    }

    console.log(`Growing pool ${projectName} from ${initial.ready.length} to ${size} ready instance(s).`);
    while (poolStatus(projectName).ready.length < size) {
      await plant(projectName, undefined, { label: ["grove.pool=ready"] });
    }
    printPoolStatus(projectName);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function parseSize(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("--size must be a non-negative safe integer");
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new Error("--size must be a non-negative safe integer");
  return size;
}

/**
 * The one readiness rule `pool`, `claim`, and `grove ui` all report. An in-flight plant carries
 * needsState until it completes, so it counts; a settled instance that never got its state does
 * not, because claim refuses it.
 */
export function isPoolReady(instance: {
  spec: { labels: Record<string, string> } | null;
  pending?: GroveInstance["pending"] | null;
  needsState?: string | null;
}): boolean {
  if (instance.spec?.labels["grove.pool"] !== "ready") return false;
  if (instance.pending === "planting") return true;
  return !instance.pending && !instance.needsState;
}

function poolStatus(projectName: string) {
  const registry = loadRegistry();
  const project = registry.projects[projectName];
  if (!project) throw new Error(`project "${projectName}" not registered`);
  const ready = project.instances
    .filter(isPoolReady)
    .sort((a, b) => a.slot - b.slot || a.name.localeCompare(b.name));
  return { project, ready };
}

function printPoolStatus(projectName: string): void {
  const { project, ready } = poolStatus(projectName);
  console.log(`Pool ${projectName}:`);
  console.log(`  Ready: ${ready.length}`);
  console.log(`  Slots: ${ready.length ? ready.map((instance) => `${instance.slot} (${instance.name})`).join(", ") : "none"}`);
  console.log(`  Claimed: ${project.instances.length - ready.length}`);
}

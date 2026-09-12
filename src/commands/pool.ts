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
    if (initial.filling.length >= size) {
      console.log(`Pool ${projectName} already has ${initial.filling.length} ready or in-flight instance(s); requested ${size}. Nothing to do.`);
      return;
    }

    console.log(`Growing pool ${projectName} from ${initial.filling.length} to ${size} ready instance(s).`);
    while (poolStatus(projectName).filling.length < size) {
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
 * The one claimable rule `claim`, `pool`, and `grove ui` all use: labelled for the pool, settled,
 * and holding its data state. Anything `claim` would refuse must not be counted ready anywhere,
 * because every surface that prints the count offers claim as the next step.
 */
export function isPoolReady(instance: {
  spec: { labels: Record<string, string> } | null;
  pending?: GroveInstance["pending"] | null;
  needsState?: string | null;
}): boolean {
  if (instance.spec?.labels["grove.pool"] !== "ready") return false;
  return !instance.pending && !instance.needsState;
}

/** Ready, or a plant that is on its way to ready — what the growth loop counts so it does not plant over an in-flight one. */
function isPoolFilling(instance: GroveInstance): boolean {
  if (isPoolReady(instance)) return true;
  return instance.spec.labels["grove.pool"] === "ready" && instance.pending === "planting";
}

function poolStatus(projectName: string) {
  const registry = loadRegistry();
  const project = registry.projects[projectName];
  if (!project) throw new Error(`project "${projectName}" not registered`);
  const bySlot = (a: GroveInstance, b: GroveInstance) => a.slot - b.slot || a.name.localeCompare(b.name);
  const ready = project.instances.filter(isPoolReady).sort(bySlot);
  const filling = project.instances.filter(isPoolFilling).sort(bySlot);
  return { project, ready, filling };
}

function printPoolStatus(projectName: string): void {
  const { project, ready } = poolStatus(projectName);
  console.log(`Pool ${projectName}:`);
  console.log(`  Ready: ${ready.length}`);
  console.log(`  Slots: ${ready.length ? ready.map((instance) => `${instance.slot} (${instance.name})`).join(", ") : "none"}`);
  console.log(`  Claimed: ${project.instances.length - ready.length}`);
}

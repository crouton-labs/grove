import { formatGitState, gatherInventory, type InventoryTarget } from "../inventory.js";

export async function list(project?: string, options: { json?: boolean } = {}): Promise<void> {
  try {
    const inventory = await gatherInventory(project);
    if (options.json) {
      console.log(JSON.stringify(inventory));
      return;
    }
    if (inventory.projects.length === 0) {
      console.log("No projects registered. Run: grove register <path>");
      return;
    }
    for (const item of inventory.projects) {
      console.log(`\x1b[1m${item.name}\x1b[0m${item.sourceExists ? "" : " \x1b[31m(source missing)\x1b[0m"}`);
      console.log(`  ${item.source}`);
      renderTarget(item.name, item.source_target, true);
      if (item.instances.length === 0) {
        console.log("  (no instances)");
      } else {
        for (const instance of item.instances) renderTarget(item.name, instance, false);
      }
      console.log("");
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function renderTarget(project: string, target: InventoryTarget, source: boolean): void {
  const label = source ? "(source)" : target.name;
  const status = target.exists ? "\x1b[32m●\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${status} ${label} \x1b[90m(slot ${target.slot})\x1b[0m ${target.path}`);
  if (target.pending === "planting") {
    console.log(`    \x1b[33mplanting\x1b[0m — grove uproot ${project}/${target.name}`);
  } else if (!target.exists) {
    console.log("    \x1b[31mzombie — directory missing. Run grove doctor\x1b[0m");
    return;
  }
  if (target.needsState) {
    console.log(`    \x1b[33mstate not applied\x1b[0m — grove restore ${target.name} ${target.needsState}`);
  }
  if (target.ports.length) {
    console.log(`    ${target.ports.map((port) => `${port.name}:${port.port} ${port.live ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m"}`).join("  ")}`);
  }
  for (const repo of target.repos) console.log(`    ${formatGitState(repo)}`);
}

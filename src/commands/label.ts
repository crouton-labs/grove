import { saveRegistry, withRegistryLock } from "../registry.js";
import { assertLabelKey, currentRegisteredTarget, parseLabelAssignments, runSequential, selectTargets, type TargetingOptions } from "../selection.js";
import { assertTargetUsable, type GroveTarget } from "../target.js";

interface LabelOptions extends TargetingOptions {
  rm?: string[];
}

export async function label(
  targetOrProject: string | undefined,
  assignments: string[],
  options: LabelOptions,
): Promise<void> {
  try {
    const selecting = options.selector !== undefined || options.all === true;
    const parsedAssignments = parseLabelAssignments(selecting && targetOrProject?.includes("=")
      ? [targetOrProject, ...assignments]
      : assignments);
    const scope = selecting && targetOrProject?.includes("=") ? undefined : targetOrProject;
    const remove = options.rm ?? [];
    for (const key of remove) assertLabelKey(key);
    if (!Object.keys(parsedAssignments).length && !remove.length) {
      throw new Error("specify at least one label key=value or --rm key");
    }
    for (const key of remove) {
      if (Object.hasOwn(parsedAssignments, key)) {
        throw new Error(`cannot add and remove label key "${key}" in one command`);
      }
    }
    const selection = selectTargets(scope, options, process.cwd());
    process.exitCode = selection.fanOut
      ? await runSequential(selection.targets, (target) => labelTarget(target, parsedAssignments, remove))
      : await labelTarget(selection.targets[0], parsedAssignments, remove);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

export async function labelTarget(
  target: GroveTarget,
  assignments: Readonly<Record<string, string>>,
  remove: readonly string[],
): Promise<number> {
  if (!target.instance) {
    throw new Error(`${target.projectName} is the project source; labels apply only to planted instances`);
  }
  assertTargetUsable(target);
  const { projectName, instance } = target;
  await withRegistryLock(async (registry) => {
    const registered = currentRegisteredTarget(registry, target);
    assertTargetUsable(registered);
    const current = registered.instance!;
    Object.assign(current.spec.labels, assignments);
    for (const key of remove) delete current.spec.labels[key];
    await saveRegistry(registry);
  });
  const changes = [
    ...Object.entries(assignments).map(([key, value]) => `${key}=${value}`),
    ...remove.map((key) => `removed ${key}`),
  ];
  console.log(`Labels updated: ${projectName}/${instance.name} (${changes.join(", ")})`);
  return 0;
}

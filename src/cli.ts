#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { register } from "./commands/register.js";
import { setup } from "./commands/setup.js";
import { GROVE_CONFIG_EXAMPLE, GROVE_CONFIG_FILE } from "./config.js";
import { dev } from "./commands/dev.js";
import { plant } from "./commands/plant.js";
import { apply } from "./commands/apply.js";
import { uproot } from "./commands/uproot.js";
import { list } from "./commands/list.js";
import { adopt } from "./commands/adopt.js";
import { doctor } from "./commands/doctor.js";
import { snapshot } from "./commands/snapshot.js";
import { restore } from "./commands/restore.js";
import { states } from "./commands/states.js";
import { open } from "./commands/open.js";
import { start } from "./commands/start.js";
import { stop } from "./commands/stop.js";
import { status } from "./commands/status.js";
import { reset } from "./commands/reset.js";
import { label } from "./commands/label.js";
import { ui } from "./commands/ui.js";
import { noticeIfUpdateAvailable } from "./update-notice.js";
import { SECRET_ENV_HELP } from "./env.js";

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

// Notify (don't auto-install) when a newer grove is published. Throttled, and
// written to stderr so stdout stays clean for callers that parse it.
await noticeIfUpdateAvailable(version);

// pnpm passes the argument separator through to package scripts. Strip it so the
// documented `pnpm dev -- <verb>` form reaches Grove exactly as `<verb>` does.
if (process.argv[2] === "--") process.argv.splice(2, 1);

const program = new Command();

program
  .name("grove")
  .description("Parallel project instance manager")
  .version(version)
  .addHelpText("after", `\n${SECRET_ENV_HELP}\n`);

program
  .command("dev [args...]")
  .description("Dispatch the registered project's development command")
  .helpOption(false)
  .allowUnknownOption()
  .allowExcessArguments()
  .action((args: string[]) => dev(args));

const SETUP_HELP = `Repository contract

Setup requires ${GROVE_CONFIG_FILE} at the source repository root. Grove validates it but never creates or overwrites repository config or lifecycle files.

${GROVE_CONFIG_EXAMPLE}

Machine registration

Setup creates a missing registration, preserves an exact one, and only reconciles a registration that already matches the lifecycle contract but lacks its ${GROVE_CONFIG_FILE} pointer. A different source, config path, ports, aliases, teardown script, or legacy init script is consequential; use \`register --update\` explicitly.

Setup refuses a planted instance and names its source root. It prints the port-derived slot cap, finishes with the same health validation as \`grove doctor\`, and reports Repository, Machine, and Health separately.`;

program
  .command("setup [path]")
  .description("Validate a source repository, register it, and print its slot cap")
  .addHelpText("after", `\n${SETUP_HELP}\n`)
  .action(setup);

program
  .command("register <path>")
  .description("Register a project source directory and print its slot cap")
  .option("--name <name>", "Project name (defaults to dir basename)")
  .option("--init <script>", "Init script path (relative to project root)")
  .option(
    "--teardown <script>",
    "Teardown script path (relative to project root)",
  )
  .option(
    "--port <spec...>",
    "Port definition: name:base:offset (repeatable, e.g. core:3068:100)",
  )
  .option(
    "--config <path>",
    "Project config relative to the source root (default: .grove/config.json)",
  )
  .option("--update", "Update existing registration instead of erroring on duplicate")
  .addHelpText("after", `\n${GROVE_CONFIG_EXAMPLE}\n`)
  .action(register);

const CODE_GRAMMAR = `--code-from picks the code a new instance starts from:
  configured    each repo's branch from ${GROVE_CONFIG_FILE} (the default)
  @source       each source repo's exact current commit, including commits
                that were never pushed; refuses if any source repo is dirty

Code and state are independent: \`--code-from @source --from @source\` is the
current checkout with its current data, while a bare \`plant\` is the configured
branches at the baseline state.`;

const REF_GRAMMAR = `A state ref is one of:
  baseline      the project's own empty/migrated baseline (the default)
  @<instance>   captured live from that instance; @source means the project source
  <name>        a snapshot stored by \`grove snapshot\`

All three are driven by the project's own \`stateCommand\`; a project without
one has no state layer and plants exactly as before.`;

const SLOT_CAP_GRAMMAR = `Slots are positive safe integers numbered from 1. Grove derives each project's cap from its declared ports: every port for slots 0 through the cap must be distinct and at most 65535. \`grove register\` and \`grove setup\` print the cap; \`grove plant\` refuses a requested slot above it.

Plant reserves its registry entry as \`planting\` before copying files. An interrupted plant remains visible and can only be removed with \`grove uproot <project/name>\`.`;

const TARGETING_HELP = `Target one instance with \`<target>\`, select instances whose labels all match with \`-l key=value[,key=value] [project]\`, or select every planted instance with \`--all [project]\`. Selectors and \`--all\` never match the project source (slot 0). A multi-target command runs sequentially in slot order, stops after the first non-zero exit, and prints a summary including targets that never started.`;

function collectString(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .command("plant <project> [name]")
  .description("Reserve a slot, then create a new project instance")
  .option("--slot <n>", "Positive safe integer slot (auto-assigned if omitted)")
  .option("--path <path>", "Custom target path (default: sibling to source)")
  .option("--code-from <mode>", "Code to start from: configured | @source (default: configured)")
  .option("--from <ref>", "State to start from (default: baseline)")
  .option("--ignore-fingerprint", "Restore even when the captured schema differs")
  .option("--label <key=value>", "Instance label; repeatable (key: [a-z0-9._-]+)", collectString, [])
  .addHelpText("after", `\n${CODE_GRAMMAR}\n\n${REF_GRAMMAR}\n\n${SLOT_CAP_GRAMMAR}\n`)
  .action(plant);

program
  .command("apply [target-or-project]")
  .description("Reapply the source config to one target or a selected instance set")
  .option("-l, --selector <key=value[,key=value]>", "Select instances whose labels all match")
  .option("--all", "Select every planted instance")
  .option("--force", "Apply even when a target repo has tracked changes")
  .addHelpText("after", `\n${TARGETING_HELP}\n\nApply reruns copyFromSource, secrets, patchPortsIn, substituteIn, install, and setup.sh for an existing instance. It never clones code or applies state. It refuses the project source, planting instances, a source port contract that differs from the registration (run grove register --update), and configured repositories that are not Git checkouts. It also refuses tracked changes unless --force; --force does not waive the checkout validation. Untracked files may be overwritten by copyFromSource.\n`)
  .action(apply);

program
  .command("snapshot <project/instance> <name>")
  .description("Capture an instance's state into the snapshot store")
  .option("--force", "Replace an existing snapshot of the same name")
  .action(snapshot);

program
  .command("restore [target-or-project] [ref]")
  .description("Load a state ref into one target or a selected instance set")
  .option("-l, --selector <key=value[,key=value]>", "Select instances whose labels all match")
  .option("--all", "Select every planted instance")
  .option("--force", "Skip confirmation prompt")
  .option("--ignore-fingerprint", "Restore even when the captured schema differs")
  .addHelpText("after", `\n${TARGETING_HELP}\n\nFor one target: \`grove restore <target> <ref>\`. With -l or --all: \`grove restore [project] <ref> -l ...\`; omit [project] when it can be resolved from the current directory or is the only registered project.\n\n${REF_GRAMMAR}\n`)
  .action(restore);

program
  .command("states [project]")
  .description("List stored snapshots")
  .option("--rm <name>", "Delete a snapshot (requires a project)")
  .action(states);

program
  .command("uproot [target-or-project]")
  .description("Tear down one target or a selected instance set and remove it from registry")
  .option("-l, --selector <key=value[,key=value]>", "Select instances whose labels all match")
  .option("--all", "Select every planted instance")
  .option("--force", "Skip confirmation prompt; required with -l or --all")
  .addHelpText("after", `\n${TARGETING_HELP}\n\nUproot with -l or --all requires --force. The configured teardown script alone receives GROVE_SIBLINGS_JSON: the slot-sorted JSON inventory remaining after this instance is gone, including the source at slot 0. No other dispatched command receives it.\n`)
  .action(uproot);

program
  .command("list [project]")
  .description("List instances, including labels, planting state, git state, and port health")
  .option("--json", "Print machine-readable inventory, including each instance spec.labels")
  .action((project: string | undefined, options: { json?: boolean }) => list(project, options));

program
  .command("open [target]")
  .description("Print a target's absolute path")
  .option("--json", "Print target identity and path as JSON")
  .action(open);

for (const [name, description, action] of [
  ["start", "Run a target's lifecycle start command", start],
  ["stop", "Run a target's lifecycle stop command", stop],
  ["status", "Run a target's lifecycle status command", status],
  ["reset", "Run a target's lifecycle reset command", reset],
] as const) {
  program
    .command(`${name} [target-or-project]`)
    .description(`${description} for one target or a selected instance set`)
    .option("-l, --selector <key=value[,key=value]>", "Select instances whose labels all match")
    .option("--all", "Select every planted instance")
    .addHelpText("after", `\n${TARGETING_HELP}\n`)
    .action(action);
}

program
  .command("label [target-or-project] [key=value...]")
  .description("Add or remove labels on one target or a selected instance set")
  .option("-l, --selector <key=value[,key=value]>", "Select instances whose labels all match")
  .option("--all", "Select every planted instance")
  .option("--rm <key>", "Remove a label key; repeatable", collectString, [])
  .addHelpText("after", `\n${TARGETING_HELP}\n\nFor one target: \`grove label <target> key=value ... [--rm key]\`. With -l or --all: \`grove label [project] key=value ... -l ...\`; omit [project] when it can be resolved from the current directory or is the only registered project. Label keys must match [a-z0-9._-]+.\n`)
  .action(label);

program
  .command("adopt <project> <name> <path>")
  .description("Adopt an existing instance into the registry")
  .option("--slot <n>", "Positive safe integer slot (auto-detected from .env if omitted)")
  .action(adopt);

program
  .command("ui [project]")
  .description("Full-screen slot table through the project's computed slot cap")
  .action((project: string | undefined) => ui(project));

program
  .command("doctor [project]")
  .description("Validate registry, secret env files, report planting instances, and prune zombies")
  .addHelpText("after", `\n${SECRET_ENV_HELP}\n`)
  .action(doctor);

// `dev` is a raw forwarding boundary: Commander must never parse its tail.
if (process.argv[2] === "dev") {
  dev(process.argv.slice(3));
} else {
  program.parse();
}

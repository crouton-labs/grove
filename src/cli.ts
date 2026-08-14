#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { register } from "./commands/register.js";
import { GROVE_CONFIG_EXAMPLE } from "./config.js";
import { dev } from "./commands/dev.js";
import { plant } from "./commands/plant.js";
import { uproot } from "./commands/uproot.js";
import { list } from "./commands/list.js";
import { adopt } from "./commands/adopt.js";
import { doctor } from "./commands/doctor.js";
import { snapshot } from "./commands/snapshot.js";
import { restore } from "./commands/restore.js";
import { states } from "./commands/states.js";
import { noticeIfUpdateAvailable } from "./update-notice.js";

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

// Notify (don't auto-install) when a newer grove is published. Throttled, and
// written to stderr so stdout stays clean for callers that parse it.
await noticeIfUpdateAvailable(version);

const program = new Command();

program
  .name("grove")
  .description("Parallel project instance manager")
  .version(version);

program
  .command("dev [args...]")
  .description("Dispatch the registered project's development command")
  .helpOption(false)
  .allowUnknownOption()
  .allowExcessArguments()
  .action((args: string[]) => dev(args));

program
  .command("register <path>")
  .description("Register a project source directory")
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

const REF_GRAMMAR = `A state ref is one of:
  baseline      the project's own empty/migrated baseline (the default)
  @<instance>   captured live from that instance; @source means the project source
  <name>        a snapshot stored by \`grove snapshot\`

All three are driven by the project's own \`stateCommand\`; a project without
one has no state layer and plants exactly as before.`;

program
  .command("plant <project> [name]")
  .description("Create a new project instance (name defaults to the slot number)")
  .option("--slot <n>", "Slot number (auto-assigned if omitted)")
  .option("--path <path>", "Custom target path (default: sibling to source)")
  .option("--from <ref>", "State to start from (default: baseline)")
  .option("--ignore-fingerprint", "Restore even when the captured schema differs")
  .addHelpText("after", `\n${REF_GRAMMAR}\n`)
  .action(plant);

program
  .command("snapshot <project/instance> <name>")
  .description("Capture an instance's state into the snapshot store")
  .option("--force", "Replace an existing snapshot of the same name")
  .action(snapshot);

program
  .command("restore <project/instance> <ref>")
  .description("Load a state ref into an existing instance, replacing its current state")
  .option("--force", "Skip confirmation prompt")
  .option("--ignore-fingerprint", "Restore even when the captured schema differs")
  .addHelpText("after", `\n${REF_GRAMMAR}\n`)
  .action(restore);

program
  .command("states [project]")
  .description("List stored snapshots")
  .option("--rm <name>", "Delete a snapshot (requires a project)")
  .action(states);

program
  .command("uproot <project/name>")
  .description("Tear down an instance and remove from registry")
  .option("--force", "Skip confirmation prompt")
  .action(uproot);

program
  .command("list [project]")
  .description("List instances and port health")
  .action(list);

program
  .command("adopt <project> <name> <path>")
  .description("Adopt an existing instance into the registry")
  .option("--slot <n>", "Slot number (auto-detected from .env if omitted)")
  .action(adopt);

program
  .command("doctor [project]")
  .description("Validate registry, prune zombie instances")
  .action(doctor);

// `dev` is a raw forwarding boundary: Commander must never parse its tail.
if (process.argv[2] === "dev") {
  dev(process.argv.slice(3));
} else {
  program.parse();
}

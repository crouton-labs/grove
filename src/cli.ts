#!/usr/bin/env node
import { Command } from "commander";
import { register } from "./commands/register.js";
import { plant } from "./commands/plant.js";
import { uproot } from "./commands/uproot.js";
import { list } from "./commands/list.js";
import { adopt } from "./commands/adopt.js";
import { doctor } from "./commands/doctor.js";

const program = new Command();

program
  .name("grove")
  .description("Parallel project instance manager")
  .version("0.1.0");

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
  .option("--from-config", "Load port definitions from .claude/grove/config.json")
  .option("--update", "Update existing registration instead of erroring on duplicate")
  .action(register);

program
  .command("plant <project> <name>")
  .description("Create a new project instance")
  .option("--slot <n>", "Slot number (auto-assigned if omitted)")
  .option("--path <path>", "Custom target path (default: sibling to source)")
  .action(plant);

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

program.parse();

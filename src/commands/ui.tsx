import { spawn } from "child_process";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import type { LifecycleRole } from "../config.js";
import {
  fetchRepos,
  formatGitState,
  gatherInventory,
  type InventoryProject,
  type InventoryTarget,
} from "../inventory.js";
import { captureChild, planLifecycle, runLifecycleCaptured, type LifecycleRun } from "../lifecycle.js";
import { loadRegistry } from "../registry.js";
import { loadSettings } from "../settings.js";
import { pendingResolution } from "../state.js";
import { resolveTargetFromCwd, type GroveTarget } from "../target.js";
import { killSessionOnStop, switchToSession } from "../tmux.js";
import { isPoolReady } from "./pool.js";

const LOG_LINES = 12;
const STATUS_PREFIX_WIDTH = 8;
/** Empty rows shown by default, which keeps every digit key 0-9 on a row. */
const DEFAULT_SLOT_WINDOW = 9;
/** Rows outside the variable region: the title, the column header, two dividers, the message line, and both footers. */
const CHROME_ROWS = 7;
/** The detail pane's fixed lines: the target header and the repos line. */
const DETAIL_FIXED_ROWS = 2;
/** Terminal rows the table cannot have: the chrome, the detail pane's fixed lines, and one status row. */
const RESERVED_ROWS = CHROME_ROWS + DETAIL_FIXED_ROWS + 1;
/** The STATE column: the longest reachable combination, `stale pool`, plus a trailing space. */
const STATE_WIDTH = 12;

export async function ui(projectRef?: string): Promise<void> {
  try {
    assertInteractive();
    const { name, projects } = resolveProjectSelection(projectRef);
    enterAltScreen();
    try {
      const app = render(<Root initialProject={name} projects={projects} />, { exitOnCtrlC: false });
      await app.waitUntilExit();
    } finally {
      leaveAltScreen();
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

/** ink needs raw mode on stdin and owns stdout; neither survives a pipe. */
function assertInteractive(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("grove ui needs a terminal on both stdin and stdout — it cannot be piped or redirected. For a machine-readable inventory, run: grove list --json");
  }
}

function resolveProjectSelection(projectRef?: string): { name?: string; projects: string[] } {
  const registry = loadRegistry();
  const projects = Object.keys(registry.projects).sort();
  if (projects.length === 0) {
    throw new Error("no projects registered. Run: grove register <path>");
  }
  if (projectRef !== undefined) {
    if (!registry.projects[projectRef]) {
      throw new Error(`project "${projectRef}" not registered. Registered projects: ${projects.join(", ")}`);
    }
    return { name: projectRef, projects };
  }
  const fromCwd = resolveTargetFromCwd(process.cwd());
  if (fromCwd) return { name: fromCwd.projectName, projects };
  if (projects.length === 1) return { name: projects[0], projects };
  return { projects };
}

// --- alternate screen -------------------------------------------------------
// ink renders inline, so grove ui switches the terminal itself and switches back
// on every exit path, including a signal, so scrollback is never shredded.

let altScreenActive = false;

function enterAltScreen(): void {
  if (altScreenActive) return;
  altScreenActive = true;
  process.stdout.write("\x1b[?1049h");
  process.on("exit", leaveAltScreen);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      leaveAltScreen();
      process.exit(130);
    });
  }
}

function leaveAltScreen(): void {
  if (!altScreenActive) return;
  altScreenActive = false;
  process.stdout.write("\x1b[?1049l\x1b[?25h");
}

// --- rows -------------------------------------------------------------------

interface Row {
  key: string;
  slot: number;
  isSource: boolean;
  target: InventoryTarget | null;
}

/**
 * The rows the table shows, and how many it had to drop. Every slot the project has is a row —
 * the source at slot 0, each instance, and each empty slot up to the project's computed cap (or
 * the default window when `maxSlot === null`, rather than filling a tall terminal with empty
 * rows). The terminal-height cap then applies to that whole list, not only to the generated empty
 * rows: an instance at a high slot costs a row like any other, every row comes out of the status
 * region's budget, and a table taller than the terminal pushes the footer off screen. When rows
 * are dropped, one of the rows that fit goes to the notice that says so, so the table never
 * silently hides a slot.
 */
function buildRows(project: InventoryProject, terminalRows: number): { rows: Row[]; hidden: number } {
  const rows: Row[] = [{ key: "source", slot: 0, isSource: true, target: project.source_target }];
  const occupied = new Set<number>();
  for (const instance of project.instances) {
    rows.push({ key: `i:${instance.name}`, slot: instance.slot, isSource: false, target: instance });
    occupied.add(instance.slot);
  }
  const highestEmptySlot = project.maxSlot === null ? DEFAULT_SLOT_WINDOW : project.maxSlot;
  for (let slot = 1; slot <= highestEmptySlot; slot++) {
    if (!occupied.has(slot)) rows.push({ key: `empty:${slot}`, slot, isSource: false, target: null });
  }
  rows.sort((a, b) => a.slot - b.slot || (a.isSource ? -1 : b.isSource ? 1 : 0));
  // A terminal short enough to leave under two rows has already overrun; holding the floor at two
  // keeps one slot and its notice rather than a row that claims the table is complete.
  const fits = Math.max(2, terminalRows - RESERVED_ROWS);
  if (rows.length <= fits) return { rows, hidden: 0 };
  return { rows: rows.slice(0, fits - 1), hidden: rows.length - (fits - 1) };
}

const hiddenRowNotice = (hidden: number) =>
  `… ${hidden} more ${hidden === 1 ? "slot" : "slots"} not shown — the terminal is too short`;

/** The single branch every repo agrees on, or the literal word `mixed`. */
function aggregateBranch(target: InventoryTarget): string {
  const values = target.repos.map((repo) => (repo.dirty === null ? "?" : repo.branch ?? "(detached)"));
  if (values.length === 0) return "—";
  const distinct = new Set(values);
  return distinct.size === 1 ? values[0] : "mixed";
}

/** Totals across repos that have an upstream, with `?` when any repo is unknown. */
function aggregateSync(target: InventoryTarget): string {
  if (target.repos.length === 0) return "—";
  let ahead = 0;
  let behind = 0;
  let unknown = false;
  for (const repo of target.repos) {
    if (repo.ahead === null || repo.behind === null || repo.upstream === null) unknown = true;
    ahead += repo.ahead ?? 0;
    behind += repo.behind ?? 0;
  }
  return `↑${ahead} ↓${behind}${unknown ? " ?" : ""}`;
}

/** `✱` outranks `?`: a tracked change Grove knows about must not be hidden by a repo it could not read. */
function aggregateDirty(target: InventoryTarget): string {
  if (target.repos.some((repo) => repo.dirty)) return "✱";
  return target.repos.some((repo) => repo.dirty === null) ? "?" : "";
}

function pad(value: string, width: number): string {
  return value.length > width ? value.slice(0, width - 1) + "…" : value.padEnd(width);
}

interface StateToken {
  text: string;
  color: string;
}

/**
 * The recorded intent a fleet is scanned for: an instance whose data state was never applied, one
 * built from an older source config, and one waiting in the ready pool. Ordered by what makes
 * someone act, so a narrow STATE column truncates the least urgent word first.
 */
function stateTokens(target: InventoryTarget): StateToken[] {
  const tokens: StateToken[] = [];
  if (target.needsState) tokens.push({ text: "no-state", color: "yellow" });
  if (target.configStale) tokens.push({ text: "stale", color: "yellow" });
  if (isPoolReady(target)) tokens.push({ text: "pool", color: "green" });
  return tokens;
}

/** Ready and claimed counts by the same rule `grove pool` prints, so the two surfaces agree. */
function poolCounts(project: InventoryProject): { ready: number; claimed: number } {
  const ready = project.instances.filter(isPoolReady).length;
  return { ready, claimed: project.instances.length - ready };
}

/** Labels as `grove list` writes them: sorted by key, space separated. */
function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(" ") : "(none)";
}

/** Enough config hash to tell two revisions apart by eye; `grove list --json` carries all of it. */
function formatApplied(target: InventoryTarget): string {
  const applied = target.applied;
  if (!applied) return "(never applied)";
  const when = applied.at.slice(0, 16).replace("T", " ");
  const revisions = `${target.revisions} revision${target.revisions === 1 ? "" : "s"}`;
  const rolledBack = applied.rolledBackFrom ? ` · rolled back from ${applied.rolledBackFrom.slice(0, 16).replace("T", " ")}` : "";
  return `config ${applied.configHash.slice(0, 8)} · ${when} · ${revisions}${rolledBack}`;
}

// --- child processes --------------------------------------------------------

/** Run grove's own CLI as a child so its output lands in the log pane. */
function runGroveCaptured(args: string[], onLine: (line: string) => void): LifecycleRun {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return captureChild(child, onLine);
}

// --- components -------------------------------------------------------------

function Root({ initialProject, projects }: { initialProject?: string; projects: string[] }) {
  const [name, setName] = useState<string | undefined>(initialProject);
  if (!name) return <Picker projects={projects} onSelect={setName} />;
  return <App projectName={name} />;
}

function Picker({ projects, onSelect }: { projects: string[]; onSelect: (name: string) => void }) {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "q" || key.escape) return exit();
    if (key.upArrow || input === "k") setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow || input === "j") setIndex((i) => Math.min(projects.length - 1, i + 1));
    if (key.return) onSelect(projects[index]);
  });
  return (
    <Box flexDirection="column">
      <Text bold>grove ui — pick a project</Text>
      <Text dimColor>The current directory is outside every registered project root.</Text>
      <Box marginTop={1} flexDirection="column">
        {projects.map((project, i) => (
          <Text key={project} color={i === index ? "cyan" : undefined}>
            {i === index ? "▸ " : "  "}
            {project}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · Enter select · q quit</Text>
      </Box>
    </Box>
  );
}

interface ActionState {
  title: string;
  command: string;
  /** The tail shown while the action runs. */
  lines: string[];
  /** Every line the action wrote, expanded for display, set once it exits. */
  output: string[] | null;
  startedAt: number;
  exit: number | null;
}

interface Confirmation {
  prompt: string;
  run: () => void;
}

/** One line of typed input an action needs before it can run: labels, or a pool size. */
interface Prompt {
  label: string;
  hint: string;
  value: string;
  submit: (value: string) => void;
}

function App({ projectName }: { projectName: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [project, setProject] = useState<InventoryProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState(0);
  const [message, setMessage] = useState("");
  const [statusText, setStatusText] = useState<{ key: string; lines: string[] } | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [help, setHelp] = useState(false);
  const [, setTick] = useState(0);
  const interrupt = useRef<(() => void) | null>(null);

  const running = action !== null && action.exit === null;

  const refresh = useCallback(async () => {
    try {
      const inventory = await gatherInventory(projectName);
      const found = inventory.projects[0];
      if (!found) throw new Error(`project "${projectName}" not registered.`);
      setProject(found);
      setError(null);
    } catch (loadError) {
      setError((loadError as Error).message);
    }
  }, [projectName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const terminalRows = stdout?.rows ?? 24;
  // The variable region is sized before the table, so the lines the selected row (or the help pane)
  // adds come out of the table rather than off the top of the frame. The selected target is read
  // from the project rather than from the rows the cap produces, which would be circular; when the
  // cap drops the selected row the index below falls back to the source row, whose detail pane is
  // never taller than what was reserved.
  const selectedTarget = project
    ? slot === 0
      ? project.source_target
      : project.instances.find((instance) => instance.slot === slot) ?? null
    : null;
  const extraRows = help ? HELP_EXTRA_ROWS : extraDetailRows(selectedTarget);
  const { rows, hidden } = useMemo(
    () => (project ? buildRows(project, terminalRows - extraRows) : { rows: [] as Row[], hidden: 0 }),
    [project, terminalRows, extraRows],
  );
  const index = Math.max(0, rows.findIndex((row) => row.slot === slot));
  const row = rows[index] as Row | undefined;
  const target = row?.target ?? null;
  // The source row's CLI target is the bare project name; only instances are addressed project/name.
  const targetRef = target && !row?.isSource ? `${projectName}/${target.name}` : projectName;

  const startAction = useCallback(
    (title: string, command: string, start: (onLine: (line: string) => void) => LifecycleRun, done?: (code: number, output: string[]) => void) => {
      setStatusText(null);
      setMessage("");
      setAction({ title, command, lines: [], output: null, startedAt: Date.now(), exit: null });
      // Every line is kept here; the pane shows a tail while the action runs and the whole of it,
      // as much as fits, once it exits.
      const captured: string[] = [];
      const onLine = (line: string) => {
        captured.push(line);
        setAction((current) => (current ? { ...current, lines: [...current.lines, line].slice(-LOG_LINES) } : current));
      };
      let run: LifecycleRun;
      try {
        run = start(onLine);
      } catch (startError) {
        setAction(null);
        setMessage((startError as Error).message);
        return;
      }
      interrupt.current = run.interrupt;
      run.exit.then(
        (code) => {
          interrupt.current = null;
          const output = expandJsonOutput(captured) ?? captured;
          setAction((current) => (current ? { ...current, exit: code, output } : current));
          done?.(code, output);
          void refresh();
        },
        (runError: Error) => {
          interrupt.current = null;
          setAction(null);
          setMessage(runError.message);
        },
      );
    },
    [refresh],
  );

  /**
   * Resolve the role against the config on disk, refuse if it is undeclared, confirm when asked,
   * then run. Resolution comes before the confirmation so an undeclared role never prompts, and it
   * reads the config rather than the gathered row so a stale row can never skip the prompt.
   *
   * The plan built before the prompt only decides whether to prompt: the registry and the project's
   * config can both change while the confirmation waits for a reply, so the run resolves the target
   * and plans the role again and executes that fresh plan.
   */
  const runRole = useCallback(
    (role: LifecycleRole, confirmPrompt?: string) => {
      if (!row) return;
      if (!target) return setMessage(`slot ${row.slot} has no instance — press p to plant one.`);
      try {
        planLifecycle(toGroveTarget(projectName, row, target), role);
      } catch (planError) {
        return setMessage((planError as Error).message);
      }
      const settings = role === "stop" ? safeSettings(setMessage) : null;
      if (role === "stop" && !settings) return;
      const run = () => {
        let groveTarget: GroveTarget;
        let plan;
        try {
          groveTarget = toGroveTarget(projectName, row, target);
          plan = planLifecycle(groveTarget, role);
        } catch (planError) {
          return setMessage((planError as Error).message);
        }
        startAction(
          `${role} ${targetRef}`,
          [plan.command, ...plan.argv].join(" "),
          (onLine) => runLifecycleCaptured(plan, onLine),
          (code, output) => {
            if (role === "status" && code === 0) {
              // The status verb's output belongs in the detail pane, so drop the action pane it ran behind.
              // Every captured line is kept; the detail pane decides how many of them fit.
              setStatusText({ key: targetRef, lines: output });
              setAction(null);
            }
            if (role === "stop" && code === 0 && settings) {
              killSessionOnStop(groveTarget, settings, (warning) => setMessage(warning));
            }
          },
        );
      };
      if (confirmPrompt) return setConfirmation({ prompt: confirmPrompt, run });
      run();
    },
    [projectName, row, startAction, target, targetRef],
  );

  const doRefresh = useCallback(() => {
    if (!project) return;
    const repos = [project.source_target, ...project.instances].flatMap((entry) => entry.repos.map((repo) => repo.path));
    startAction("refresh", `git fetch × ${repos.length}`, (onLine) => {
      const controller = new AbortController();
      const exitPromise = fetchRepos(repos, controller.signal).then((failures) => {
        if (controller.signal.aborted) onLine("interrupted — some fetches did not run");
        for (const failure of failures) onLine(`fetch failed: ${failure.path}: ${failure.error}`);
        onLine(`${repos.length - failures.length}/${repos.length} repos fetched`);
        return failures.length === 0 ? 0 : 1;
      });
      return { exit: exitPromise, interrupt: () => controller.abort() };
    });
  }, [project, startAction]);

  /**
   * Every action is grove's own CLI run through startAction, so the pane shows the resolved argv,
   * the elapsed count, and the child's output, and the inventory is re-read when it exits.
   */
  const runGrove = (title: string, args: string[], confirmPrompt?: string) => {
    const run = () => startAction(title, `grove ${args.join(" ")}`, (onLine) => runGroveCaptured(args, onLine));
    if (confirmPrompt) return setConfirmation({ prompt: confirmPrompt, run });
    run();
  };

  /** The instance ref for an action that needs one, or null after naming grove's own refusal. */
  const requireInstance = (verb: string): string | null => {
    if (!row) return null;
    if (row.isSource) {
      setMessage(`slot 0 is the project source — grove ${verb} needs a planted instance.`);
      return null;
    }
    if (!target) {
      setMessage(`slot ${row.slot} has no instance — press p to plant one.`);
      return null;
    }
    return targetRef;
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (running) {
        interrupt.current?.();
        setMessage("Interrupted — asked the running command to stop.");
        return;
      }
      return exit();
    }
    if (help) return setHelp(false);
    if (running) return setMessage("An action is running. Ctrl-C interrupts it.");
    if (confirmation) {
      const confirmed = input === "y" || input === "Y";
      const pending = confirmation;
      setConfirmation(null);
      if (confirmed) pending.run();
      else setMessage("Cancelled.");
      return;
    }
    if (prompt) {
      if (key.escape) {
        setPrompt(null);
        return setMessage("Cancelled.");
      }
      if (key.return) {
        const value = prompt.value.trim();
        setPrompt(null);
        if (!value) return setMessage("Cancelled — nothing entered.");
        return prompt.submit(value);
      }
      if (key.backspace || key.delete) return setPrompt({ ...prompt, value: prompt.value.slice(0, -1) });
      // Only control bytes are dropped: ink already delivers an empty string for every special key,
      // and a label value may be any printable text, so filtering further would silently mangle one.
      const typed = input.replace(/[\x00-\x1f\x7f]/g, "");
      if (typed && !key.ctrl && !key.meta) return setPrompt({ ...prompt, value: prompt.value + typed });
      return;
    }
    if (input === "q" || key.escape) return exit();
    if (input === "?") return setHelp(true);
    // Until the first gather lands there is no table, so nothing below this line has a row to act on.
    if (!row) return;
    if (key.upArrow || input === "k") {
      const next = rows[Math.max(0, index - 1)];
      if (next) setSlot(next.slot);
      setAction(null);
      return;
    }
    if (key.downArrow || input === "j") {
      const next = rows[Math.min(rows.length - 1, index + 1)];
      if (next) setSlot(next.slot);
      setAction(null);
      return;
    }
    if (/^[0-9]$/.test(input)) {
      // A digit addresses the table's first ten rows, not the slot of that number: a project's port
      // cap, an instance at a high slot, or a short terminal can all leave slot N off the table, and
      // selecting a slot with no row would leave the cursor on a row it does not name.
      const next = rows[Number(input)];
      if (!next) return setMessage(`no row ${input} — this table shows ${rows.length} row${rows.length === 1 ? "" : "s"}.`);
      setSlot(next.slot);
      setAction(null);
      return;
    }
    if (input === "R") return doRefresh();
    if (input === "s") return runRole("start");
    if (input === "S") return runRole("stop");
    if (input === "t") return runRole("status");
    if (input === "r") {
      return runRole("reset", `Run the project's reset on ${targetRef}? (y/n)`);
    }
    if (input === "p") {
      if (row.isSource) return setMessage("slot 0 is the project source — it cannot be planted over.");
      if (target) return setMessage(`slot ${row.slot} already holds ${targetRef} — uproot it first.`);
      return runGrove(`plant ${projectName} slot ${row.slot}`, ["plant", projectName, "--slot", String(row.slot)]);
    }
    if (input === "u") {
      if (row.isSource) return setMessage("slot 0 is the project source — grove uproot would delete the project checkout.");
      if (!target) return setMessage(`slot ${row.slot} has no instance.`);
      return runGrove(
        `uproot ${targetRef}`,
        ["uproot", targetRef, "--force"],
        `Uproot ${targetRef}? Its directory and services go away. (y/n)`,
      );
    }
    if (input === "a" || input === "A") {
      const ref = requireInstance("apply");
      if (!ref) return;
      const force = input === "A";
      return runGrove(
        force ? `apply ${ref} --force` : `apply ${ref}`,
        force ? ["apply", ref, "--force"] : ["apply", ref],
        force
          ? `Apply the source config to ${ref}, overwriting tracked repository changes? (y/n)`
          : `Apply the source config to ${ref}? (y/n)`,
      );
    }
    if (input === "e" || input === "E") {
      const ref = requireInstance("release");
      if (!ref) return;
      const force = input === "E";
      return runGrove(
        force ? `release ${ref} --force` : `release ${ref}`,
        force ? ["release", ref, "--force"] : ["release", ref],
        `Release ${ref} into the pool? Its data state resets${force ? ", its repository changes are discarded" : ""}, and its labels become grove.pool=ready. (y/n)`,
      );
    }
    if (input === "b") {
      const ref = requireInstance("rollback");
      if (!ref || !target) return;
      if (target.revisions < 2) {
        return setMessage(`${ref} has ${target.revisions} recorded revision${target.revisions === 1 ? "" : "s"} — rollback needs two.`);
      }
      return runGrove(`rollback ${ref}`, ["rollback", ref], `Roll ${ref} back to its previous recorded revision? (y/n)`);
    }
    if (input === "l" || input === "L") {
      const ref = requireInstance("label");
      if (!ref) return;
      const removing = input === "L";
      return setPrompt({
        label: removing ? `remove labels from ${ref}` : `label ${ref}`,
        hint: removing ? "space-separated keys" : "space-separated key=value pairs",
        value: "",
        submit: (value) => {
          const words = value.split(/\s+/);
          // The prompt takes labels, not options: an option typed here would run a verb the prompt
          // does not name — `--rm` in the add prompt removes — so it is refused before argv is built.
          if (words.some((word) => word.startsWith("-"))) {
            return setMessage(`${removing ? "remove labels" : "label"} takes ${removing ? "keys" : "key=value pairs"}, not options.`);
          }
          return runGrove(`label ${ref}`, ["label", ref, ...(removing ? words.flatMap((word) => ["--rm", word]) : words)]);
        },
      });
    }
    if (input === "c") return runGrove(`claim ${projectName}`, ["claim", projectName]);
    if (input === "P") {
      return setPrompt({
        label: `pool ${projectName} --size`,
        hint: "how many ready instances the pool should hold",
        value: "",
        submit: (size) => {
          // Grove's own rule, checked before the confirmation: a size it will refuse must not be
          // authorised as if it were work about to happen.
          if (!/^\d+$/.test(size)) return setMessage("--size must be a non-negative safe integer");
          return runGrove(
            `pool ${projectName} --size ${size}`,
            ["pool", projectName, "--size", size],
            `Plant ${projectName} until ${size} ready instances exist? (y/n)`,
          );
        },
      });
    }
    if (input === "o") {
      if (!target) return setMessage(`slot ${row.slot} has no instance — press p to plant one.`);
      try {
        switchToSession(target.tmuxSession, target.path);
      } catch (switchError) {
        return setMessage((switchError as Error).message);
      }
      return exit();
    }
  });

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">{error}</Text>
        <Text dimColor>q quit</Text>
      </Box>
    );
  }
  if (!project || !row) return <Text>Gathering {projectName}…</Text>;

  const width = stdout?.columns ?? 100;
  const declares = (role: LifecycleRole) => Boolean(target?.lifecycle.includes(role));
  const tableRows = rows.length + (hidden > 0 ? 1 : 0);
  const statusBudget = statusRowBudget(terminalRows, tableRows, extraDetailRows(target));
  const poolState = poolCounts(project);
  const instanceSelected = Boolean(target) && !row.isSource;

  return (
    <Box flexDirection="column" width={width}>
      {/* Every row outside the status region truncates rather than wraps, so each is one row at any
          width — which is the chrome count statusRowBudget subtracts. */}
      {/* One Text rather than a row of them, so a narrow terminal truncates the source path — the
          least load-bearing part — instead of shrinking every part including the project name. */}
      <Text wrap="truncate-end">
        <Text bold>{`grove ui — ${projectName}`}</Text>
        <Text dimColor>{`  pool ${poolState.ready} ready · ${poolState.claimed} claimed`}</Text>
        <Text dimColor>{`  ${project.source}`}</Text>
      </Text>
      <Text dimColor wrap="truncate-end">{` ${pad("SLOT", 6)}${pad("NAME", 13)}${pad("BRANCH", 19)}${pad("", 2)}${pad("SYNC", 12)}${pad("STATE", STATE_WIDTH)}SERVICES`}</Text>
      {rows.map((entry, entryIndex) => (
        <SlotRow key={entry.key} projectName={projectName} row={entry} selected={entryIndex === index} />
      ))}
      {hidden > 0 ? <Text dimColor wrap="truncate-end">{hiddenRowNotice(hidden)}</Text> : null}
      <Text dimColor>{"─".repeat(Math.max(10, width - 1))}</Text>
      {/* One variable-height region: the running action, the selected row's detail, or help. */}
      {help ? (
        <HelpPane />
      ) : action ? (
        <ActionPane action={action} budget={variableRegionRows(terminalRows, tableRows)} width={width} />
      ) : (
        <DetailPane
          project={project}
          row={row}
          statusText={statusText?.key === targetRef ? statusText.lines : null}
          statusBudget={statusBudget}
          width={width}
        />
      )}
      <Text dimColor>{"─".repeat(Math.max(10, width - 1))}</Text>
      {help ? (
        <Text dimColor>press any key to close</Text>
      ) : (
        <Text wrap="truncate-end">
          {prompt ? (
            <Text color="yellow">
              {`${prompt.label} ▸ ${prompt.value}█  `}
              <Text dimColor>{`${prompt.hint} · Enter runs · Esc cancels`}</Text>
            </Text>
          ) : confirmation ? (
            <Text color="yellow">{confirmation.prompt}</Text>
          ) : (
            message
          )}
        </Text>
      )}
      {/* Two footer lines, both counted as chrome by statusRowBudget and RESERVED_ROWS. */}
      <Text wrap="truncate-end">
        <Text dimColor={!target}>o open</Text>
        <Text dimColor> · </Text>
        <Text dimColor={Boolean(target) || row.isSource}>p plant</Text>
        <Text dimColor> · </Text>
        <Text dimColor={!instanceSelected}>u uproot</Text>
        <Text dimColor> · </Text>
        <Text dimColor={!instanceSelected}>a apply (A force)</Text>
        <Text dimColor> · </Text>
        <Text dimColor={!instanceSelected}>e release (E force)</Text>
        <Text dimColor> · </Text>
        <Text dimColor={!instanceSelected || (target?.revisions ?? 0) < 2}>b rollback</Text>
        <Text dimColor> · </Text>
        <Text dimColor={!instanceSelected}>l label</Text>
        <Text dimColor> · </Text>
        <Text dimColor={!instanceSelected}>L rm label</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor={!declares("start")}>s start</Text>
        <Text dimColor> · </Text>
        <Text dimColor={!declares("stop")}>S stop</Text>
        <Text dimColor> · </Text>
        <Text dimColor={!declares("reset")}>r reset</Text>
        <Text dimColor> · </Text>
        <Text dimColor={!declares("status")}>t status</Text>
        <Text dimColor> · </Text>
        <Text>c claim</Text>
        <Text dimColor> · </Text>
        <Text>P pool</Text>
        <Text dimColor> · </Text>
        <Text>R refresh</Text>
        <Text dimColor> · ? help · q quit</Text>
      </Text>
    </Box>
  );
}

function SlotRow({ projectName, row, selected }: { projectName: string; row: Row; selected: boolean }) {
  const target = row.target;
  const name = row.isSource ? "(source)" : target?.name ?? "—";
  const cursor = selected ? "▸" : " ";
  const head = `${cursor}${String(row.slot).padStart(3)}  ${pad(name, 13)}`;
  if (!target) {
    return (
      <Text color={selected ? "cyan" : undefined} wrap="truncate-end">
        {head}
        <Text dimColor>(empty)</Text>
      </Text>
    );
  }
  // A reserved slot is checked before the directory, because the reservation outlives the directory
  // at both ends: plant registers the instance before it creates anything, and uproot removes the
  // directory before it deregisters. An in-flight or interrupted plant or uproot is not a zombie.
  // The row carries the resolving command too, so a fleet scan shows the recovery without selecting
  // the row; the detail pane repeats it for the selected instance.
  if (target.pending) {
    return (
      <Text color={selected ? "cyan" : undefined} wrap="truncate-end">
        {head}
        <Text color="yellow">{pad(target.pending, 14)}</Text>
        <Text dimColor>{pendingResolution(projectName, target)}</Text>
      </Text>
    );
  }
  if (!target.exists) {
    return (
      <Text color={selected ? "cyan" : undefined} wrap="truncate-end">
        {head}
        <Text color="red">zombie — directory missing</Text>
      </Text>
    );
  }
  return (
    <Text color={selected ? "cyan" : undefined} wrap="truncate-end">
      {`${head}${pad(aggregateBranch(target), 19)}${pad(aggregateDirty(target), 2)}${pad(aggregateSync(target), 12)}`}
      <StateCell tokens={stateTokens(target)} width={STATE_WIDTH} />
      {target.ports.map((port) => (
        <Text key={port.name}>
          {`${port.name}:${port.port} `}
          {port.live ? <Text color="green">●</Text> : <Text dimColor>○</Text>}
          {" "}
        </Text>
      ))}
    </Text>
  );
}

/**
 * The STATE column at a fixed width, one color per word. Every word is ASCII, so a cell's width is
 * its string length; a combination longer than the column truncates like any other cell rather than
 * pushing SERVICES out of alignment.
 */
function StateCell({ tokens, width }: { tokens: StateToken[]; width: number }) {
  const text = tokens.map((token) => token.text).join(" ");
  if (text.length > width) return <Text color={tokens[0].color}>{pad(text, width)}</Text>;
  return (
    <>
      {tokens.map((token, index) => (
        <Text key={token.text} color={token.color}>{index === 0 ? token.text : ` ${token.text}`}</Text>
      ))}
      <Text>{" ".repeat(width - text.length)}</Text>
    </>
  );
}

function DetailPane({
  project,
  row,
  statusText,
  statusBudget,
  width,
}: {
  project: InventoryProject;
  row: Row;
  statusText: string[] | null;
  statusBudget: number;
  width: number;
}) {
  const target = row.target;
  if (!target) {
    return (
      <Box flexDirection="column">
        <Text>{`${project.name} slot ${row.slot}  `}<Text dimColor>no instance — press p to plant one</Text></Text>
      </Box>
    );
  }
  const targetRef = row.isSource ? project.name : `${project.name}/${target.name}`;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>{row.isSource ? `${project.name} (source, slot 0)` : targetRef}</Text>
        <Text>{`  ${target.path}  `}</Text>
        <Text dimColor>{`session ${target.tmuxSession}`}</Text>
      </Text>
      {target.pending ? (
        <Text wrap="truncate-end">
          <Text dimColor>pending </Text>
          <Text color="yellow">{target.pending}</Text>
          <Text>{` — ${pendingResolution(project.name, target)}`}</Text>
        </Text>
      ) : null}
      {target.needsState ? (
        <Text wrap="truncate-end">
          <Text dimColor>state   </Text>
          <Text color="yellow">{`not applied (${target.needsState})`}</Text>
          <Text>{` — grove restore ${targetRef} ${target.needsState}`}</Text>
        </Text>
      ) : null}
      {/* The source has no registry entry, so it records no spec and no revisions. */}
      {target.spec ? (
        <>
          <Text wrap="truncate-end">
            <Text dimColor>intent  </Text>
            <Text>{`code ${target.spec.codeFrom} · state ${target.spec.from} · labels ${formatLabels(target.spec.labels)}`}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>applied </Text>
            <Text>{formatApplied(target)}</Text>
            {target.configStale ? <Text color="yellow">{`  stale — grove apply ${targetRef}`}</Text> : null}
          </Text>
        </>
      ) : null}
      <Text wrap="truncate-end">
        <Text dimColor>repos   </Text>
        {target.repos.length ? target.repos.map(formatGitState).join(" · ") : "(no repos declared)"}
      </Text>
      {statusText ? (
        <StatusLines lines={statusText} budget={statusBudget} width={width} />
      ) : (
        <Text>
          <Text dimColor>status  </Text>
          <Text dimColor>(press t)</Text>
        </Text>
      )}
    </Box>
  );
}

/**
 * How many terminal rows the variable region — the detail pane, the action pane, or help — may
 * occupy. Everything else on screen is one row each: the title, the column header, every table row
 * (each slot, plus the dropped-rows notice when there is one), two dividers, the message line, and
 * both footer lines.
 */
function variableRegionRows(terminalRows: number, tableRows: number): number {
  return Math.max(1, terminalRows - tableRows - CHROME_ROWS);
}

/**
 * How many of the variable region's rows the status region may occupy: what is left after the
 * detail pane's fixed lines and every further detail line the selected row brings with it.
 */
function statusRowBudget(terminalRows: number, tableRows: number, extraDetailRows: number): number {
  return Math.max(0, variableRegionRows(terminalRows, tableRows) - DETAIL_FIXED_ROWS - extraDetailRows);
}

/** Detail lines beyond the header and repos lines the status budget already accounts for. */
function extraDetailRows(target: InventoryTarget | null): number {
  if (!target) return 0;
  return (target.pending ? 1 : 0) + (target.needsState ? 1 : 0) + (target.spec ? 2 : 0);
}

const statusNotice = (hidden: number) => `… ${hidden} more ${hidden === 1 ? "line" : "lines"} not shown`;

/**
 * A deliberately conservative cell width: every non-ASCII code point counts as two columns. Ink
 * wraps at real terminal cells, and over-counting only costs a shown line, while under-counting
 * would let the region outgrow its budget and push the footer off screen.
 */
function statusRows(line: string, contentWidth: number): number {
  let cells = 0;
  for (const character of line) cells += character.codePointAt(0)! < 0x80 ? 1 : 2;
  return Math.max(1, Math.ceil(cells / contentWidth));
}

/**
 * Take status lines from the top until the budget is spent, measuring each line at the width it
 * will wrap to. Reserves the notice's own measured height whenever lines are left over, so the
 * region never grows past the budget and never drops a line without saying so.
 */
function fitStatusLines(lines: string[], budget: number, contentWidth: number): { shown: string[]; hidden: number } {
  // The notice can wrap too, and its text is longest when every line is hidden.
  const noticeRows = statusRows(statusNotice(lines.length), contentWidth);
  const shown: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const height = statusRows(line, contentWidth);
    const reserved = index === lines.length - 1 ? 0 : noticeRows;
    if (used + height + reserved > budget) break;
    shown.push(line);
    used += height;
  }
  return { shown, hidden: lines.length - shown.length };
}

/**
 * The project's status output, verbatim. Read from the top, because a status listing is ordered
 * top-down, and wrapped rather than truncated, because truncation hides content silently. Grove
 * measures these lines and never reads them.
 */
function StatusLines({ lines, budget, width }: { lines: string[]; budget: number; width: number }) {
  const contentWidth = Math.max(1, width - STATUS_PREFIX_WIDTH);
  const { shown, hidden } = fitStatusLines(lines, budget, contentWidth);
  // A terminal too short to hold the slot table has no rows left for this region at all, and one
  // spent overflowing would push the footer off the screen the table has already overrun.
  if (budget === 0) return null;
  return (
    <>
      {shown.map((line, lineIndex) => (
        // minHeight keeps a blank line in the project's output a blank row here, so the region is as
        // tall as it was measured to be and the output is shown exactly as the project wrote it.
        <Box key={lineIndex} minHeight={1}>
          <Box width={STATUS_PREFIX_WIDTH} flexShrink={0}>
            <Text dimColor>{lineIndex === 0 ? "status" : ""}</Text>
          </Box>
          <Text wrap="wrap">{line}</Text>
        </Box>
      ))}
      {hidden > 0 ? (
        <Box>
          <Box width={STATUS_PREFIX_WIDTH} flexShrink={0}>
            <Text dimColor>{shown.length === 0 ? "status" : ""}</Text>
          </Box>
          <Text dimColor>{statusNotice(hidden)}</Text>
        </Box>
      ) : null}
    </>
  );
}

/** The action's title and exit line, which every action pane shows before any output. */
const ACTION_FIXED_ROWS = 2;

/**
 * Expand a project's machine-readable output for display. A project can put `--json` in its
 * lifecycle argv, which makes the whole run one very long line — unreadable in a pane that
 * truncates. When the captured output is exactly one JSON object, it becomes one line per field,
 * with an array taking a line per element, so the fields the project prints first stay on screen
 * and a field it prints last is what overflows. Anything else is shown exactly as the project
 * wrote it. Grove only reshapes the text; it never reads a value or acts on one.
 */
function expandJsonOutput(lines: string[]): string[] | null {
  const text = lines.join("\n").trim();
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const expanded: string[] = [];
  const indent = (value: string) => {
    for (const line of value.split("\n")) expanded.push(`  ${line}`);
  };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) expanded.push(`${key}: —`);
    else if (Array.isArray(value)) {
      if (value.length === 0) expanded.push(`${key}: (none)`);
      else {
        expanded.push(`${key}:`);
        for (const entry of value) indent(typeof entry === "string" ? entry : JSON.stringify(entry, null, 2));
      }
    } else if (typeof value === "object") {
      expanded.push(`${key}:`);
      indent(JSON.stringify(value, null, 2));
    } else {
      const [first, ...rest] = String(value).split("\n");
      expanded.push(`${key}: ${first}`);
      for (const line of rest) expanded.push(`  ${line}`);
    }
  }
  return expanded;
}

/**
 * While the action runs, the tail is what matters and every line stays one row, so the pane's
 * height is known. Once it exits, the whole output is read from the top — where a project puts its
 * verdict — wrapped rather than truncated, because truncation hides content silently, and the
 * notice says how many lines did not fit.
 */
function ActionPane({ action, budget, width }: { action: ActionState; budget: number; width: number }) {
  const elapsed = Math.round((Date.now() - action.startedAt) / 1000);
  const rows = Math.max(0, budget - ACTION_FIXED_ROWS);
  const finished = action.output !== null;
  // While it runs: the most recent output, cut to the region rather than to LOG_LINES, because a
  // chatty child — claim prints its whole grove-output block — would push the footer off screen.
  const { shown, hidden } = finished
    ? fitStatusLines(action.output!, rows, Math.max(1, width - 1))
    : { shown: action.lines.slice(-rows), hidden: 0 };
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>{action.title}</Text>
        <Text dimColor>{`  ${action.command}`}</Text>
      </Text>
      <Text>
        {action.exit === null ? (
          <Text color="yellow">{`running ${elapsed}s — Ctrl-C interrupts`}</Text>
        ) : (
          <Text color={action.exit === 0 ? "green" : "red"}>{`exit ${action.exit} after ${elapsed}s`}</Text>
        )}
      </Text>
      {shown.map((line, lineIndex) => (
        // minHeight keeps a blank line in the project's output a blank row here, so the pane is as
        // tall as it was measured to be.
        <Box key={lineIndex} minHeight={1}>
          <Text dimColor wrap={finished ? "wrap" : "truncate-end"}>
            {line}
          </Text>
        </Box>
      ))}
      {hidden > 0 ? <Text dimColor>{statusNotice(hidden)}</Text> : null}
    </Box>
  );
}

/** Every line fits an 80-column terminal and truncates rather than wraps, so the pane is exactly this many rows. */
const HELP_LINES = [
  "keys — * confirms first · q or Esc quits · Ctrl-C interrupts an action",
  "↑/k ↓/j move · 0-9 jump to a row · o tmux session · R fetch and re-read",
  "p plant · u uproot* · s start · S stop · r reset* · t status verb",
  "a apply the source config* · A apply over tracked changes* · b roll back*",
  "e release into the pool* · E release discarding repo changes*",
  "l add labels · L remove labels · project: c claim · P grow the pool*",
  "STATE: no-state state never applied · stale older config · pool ready",
];

/**
 * What help costs the table beyond the detail pane it replaces, so the frame still fits. A terminal
 * shorter than CHROME_ROWS + HELP_LINES.length + the table's two-row floor cannot hold both, and the
 * floor wins: help is the screen the user asked for, and the table keeps saying how many slots it hid.
 */
const HELP_EXTRA_ROWS = HELP_LINES.length - DETAIL_FIXED_ROWS;

function HelpPane() {
  return (
    <Box flexDirection="column">
      {HELP_LINES.map((line, lineIndex) => (
        <Text key={line} bold={lineIndex === 0} wrap="truncate-end">{line}</Text>
      ))}
    </Box>
  );
}

/** Rebuild the registry-backed target a row stands for, refusing if the registry moved under us. */
function toGroveTarget(projectName: string, row: Row, target: InventoryTarget): GroveTarget {
  const project = loadRegistry().projects[projectName];
  if (!project) throw new Error(`project "${projectName}" is no longer registered — press R to re-read.`);
  // The root comes from the registry just re-read, never from the gathered row, so a target that
  // moved while the UI was open runs where it is registered rather than where it used to be.
  if (row.isSource) return { project, projectName, root: project.source };
  const instance = project.instances.find((candidate) => candidate.name === target.name && candidate.slot === target.slot);
  if (!instance) throw new Error(`${projectName}/${target.name} is no longer registered — press R to re-read.`);
  return { project, projectName, root: instance.path, instance };
}

function safeSettings(onError: (message: string) => void) {
  try {
    return loadSettings();
  } catch (error) {
    onError((error as Error).message);
    return null;
  }
}

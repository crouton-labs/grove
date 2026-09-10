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
import { resolveTargetFromCwd, type GroveTarget } from "../target.js";
import { killSessionOnStop, switchToSession } from "../tmux.js";

const LOG_LINES = 12;

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

function buildRows(project: InventoryProject): Row[] {
  const rows: Row[] = [{ key: "source", slot: 0, isSource: true, target: project.source_target }];
  const occupied = new Set<number>();
  for (const instance of project.instances) {
    rows.push({ key: `i:${instance.name}`, slot: instance.slot, isSource: false, target: instance });
    occupied.add(instance.slot);
  }
  for (let slot = 1; slot <= 9; slot++) {
    if (!occupied.has(slot)) rows.push({ key: `empty:${slot}`, slot, isSource: false, target: null });
  }
  return rows.sort((a, b) => a.slot - b.slot || (a.isSource ? -1 : b.isSource ? 1 : 0));
}

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

function aggregateDirty(target: InventoryTarget): string {
  if (target.repos.some((repo) => repo.dirty === null)) return "?";
  return target.repos.some((repo) => repo.dirty) ? "✱" : "";
}

function pad(value: string, width: number): string {
  return value.length > width ? value.slice(0, width - 1) + "…" : value.padEnd(width);
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
  lines: string[];
  startedAt: number;
  exit: number | null;
}

interface Confirmation {
  prompt: string;
  run: () => void;
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

  const rows = useMemo(() => (project ? buildRows(project) : []), [project]);
  const index = Math.max(0, rows.findIndex((row) => row.slot === slot));
  const row = rows[index] as Row | undefined;
  const target = row?.target ?? null;
  // The source row's CLI target is the bare project name; only instances are addressed project/name.
  const targetRef = target && !row?.isSource ? `${projectName}/${target.name}` : projectName;

  const startAction = useCallback(
    (title: string, command: string, start: (onLine: (line: string) => void) => LifecycleRun, done?: (code: number) => void) => {
      setStatusText(null);
      setMessage("");
      setAction({ title, command, lines: [], startedAt: Date.now(), exit: null });
      const onLine = (line: string) =>
        setAction((current) => (current ? { ...current, lines: [...current.lines, line].slice(-LOG_LINES) } : current));
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
          setAction((current) => (current ? { ...current, exit: code } : current));
          done?.(code);
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
   */
  const runRole = useCallback(
    (role: LifecycleRole, confirmPrompt?: string) => {
      if (!target || !row) return setMessage(`slot ${row?.slot} has no instance — press p to plant one.`);
      let plan;
      let groveTarget: GroveTarget;
      try {
        groveTarget = toGroveTarget(projectName, row, target);
        plan = planLifecycle(groveTarget, role);
      } catch (planError) {
        return setMessage((planError as Error).message);
      }
      const settings = role === "stop" ? safeSettings(setMessage) : null;
      if (role === "stop" && !settings) return;
      const captured: string[] = [];
      const run = () =>
        startAction(
          `${role} ${targetRef}`,
          [plan.command, ...plan.argv].join(" "),
          (onLine) =>
            runLifecycleCaptured(plan, (line) => {
              captured.push(line);
              onLine(line);
            }),
          (code) => {
            if (role === "status" && code === 0) {
              // The status verb's output belongs in the detail pane, so drop the action pane it ran behind.
              setStatusText({ key: targetRef, lines: captured.slice(-LOG_LINES) });
              setAction(null);
            }
            if (role === "stop" && code === 0 && settings) {
              killSessionOnStop(groveTarget, settings, (warning) => setMessage(warning));
            }
          },
        );
      if (confirmPrompt) return setConfirmation({ prompt: confirmPrompt, run });
      run();
    },
    [projectName, row, startAction, target, targetRef],
  );

  const doRefresh = useCallback(() => {
    if (!project) return;
    const repos = [project.source_target, ...project.instances].flatMap((entry) => entry.repos.map((repo) => repo.path));
    startAction("refresh", `git fetch × ${repos.length}`, (onLine) => {
      let cancelled = false;
      const exitPromise = fetchRepos(repos).then((failures) => {
        if (cancelled) onLine("interrupted — some fetches may not have run");
        for (const failure of failures) onLine(`fetch failed: ${failure.path}: ${failure.error}`);
        onLine(`${repos.length - failures.length}/${repos.length} repos fetched`);
        return failures.length === 0 ? 0 : 1;
      });
      return { exit: exitPromise, interrupt: () => { cancelled = true; } };
    });
  }, [project, startAction]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (running) {
        interrupt.current?.();
        setMessage("Interrupted — sent SIGINT to the running command.");
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
    if (input === "q" || key.escape) return exit();
    if (input === "?") return setHelp(true);
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
      setSlot(Number(input));
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
      if (row?.isSource) return setMessage("slot 0 is the project source — it cannot be planted over.");
      if (target) return setMessage(`slot ${row?.slot} already holds ${targetRef} — uproot it first.`);
      const plantSlot = row?.slot;
      if (plantSlot === undefined) return;
      return startAction(`plant ${projectName} slot ${plantSlot}`, `grove plant ${projectName} --slot ${plantSlot}`, (onLine) =>
        runGroveCaptured(["plant", projectName, "--slot", String(plantSlot)], onLine),
      );
    }
    if (input === "u") {
      if (row?.isSource) return setMessage("slot 0 is the project source — grove uproot would delete the project checkout.");
      if (!target) return setMessage(`slot ${row?.slot} has no instance.`);
      const name = target.name;
      return setConfirmation({
        prompt: `Uproot ${targetRef}? Its directory and services go away. (y/n)`,
        run: () =>
          startAction(`uproot ${targetRef}`, `grove uproot ${projectName}/${name} --force`, (onLine) =>
            runGroveCaptured(["uproot", `${projectName}/${name}`, "--force"], onLine),
          ),
      });
    }
    if (input === "o") {
      if (!target) return setMessage(`slot ${row?.slot} has no instance — press p to plant one.`);
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

  return (
    <Box flexDirection="column" width={width}>
      <Box>
        <Text bold>{`grove ui — ${projectName}`}</Text>
        <Text dimColor>{`  ${project.source}`}</Text>
      </Box>
      <Text dimColor>{` ${pad("SLOT", 6)}${pad("NAME", 13)}${pad("BRANCH", 19)}${pad("", 2)}${pad("SYNC", 12)}SERVICES`}</Text>
      {rows.map((entry, entryIndex) => (
        <SlotRow key={entry.key} row={entry} selected={entryIndex === index} />
      ))}
      <Text dimColor>{"─".repeat(Math.max(10, width - 1))}</Text>
      {action ? (
        <ActionPane action={action} />
      ) : (
        <DetailPane project={project} row={row} statusText={statusText?.key === targetRef ? statusText.lines : null} />
      )}
      <Text dimColor>{"─".repeat(Math.max(10, width - 1))}</Text>
      {help ? (
        <HelpPane />
      ) : (
        <Text>{confirmation ? <Text color="yellow">{confirmation.prompt}</Text> : message}</Text>
      )}
      <Box>
        <Text>
          <Text dimColor={!target}>o open</Text>
          <Text dimColor> · </Text>
          <Text dimColor={Boolean(target) || row.isSource}>p plant</Text>
          <Text dimColor> · </Text>
          <Text dimColor={!target || row.isSource}>u uproot</Text>
          <Text dimColor> · </Text>
          <Text dimColor={!declares("start")}>s start</Text>
          <Text dimColor> · </Text>
          <Text dimColor={!declares("stop")}>S stop</Text>
          <Text dimColor> · </Text>
          <Text dimColor={!declares("reset")}>r reset</Text>
          <Text dimColor> · </Text>
          <Text dimColor={!declares("status")}>t status</Text>
          <Text dimColor> · </Text>
          <Text>R refresh</Text>
          <Text dimColor> · ? help · q quit</Text>
        </Text>
      </Box>
    </Box>
  );
}

function SlotRow({ row, selected }: { row: Row; selected: boolean }) {
  const target = row.target;
  const name = row.isSource ? "(source)" : target?.name ?? "—";
  const cursor = selected ? "▸" : " ";
  if (!target) {
    return (
      <Text color={selected ? "cyan" : undefined}>
        {`${cursor}${String(row.slot).padStart(3)}  ${pad(name, 13)}`}
        <Text dimColor>(empty)</Text>
      </Text>
    );
  }
  if (!target.exists) {
    return (
      <Text color={selected ? "cyan" : undefined}>
        {`${cursor}${String(row.slot).padStart(3)}  ${pad(name, 13)}`}
        <Text color="red">zombie — directory missing</Text>
      </Text>
    );
  }
  return (
    <Text color={selected ? "cyan" : undefined} wrap="truncate-end">
      {`${cursor}${String(row.slot).padStart(3)}  ${pad(name, 13)}${pad(aggregateBranch(target), 19)}${pad(aggregateDirty(target), 2)}${pad(aggregateSync(target), 12)}`}
      {target.ports.map((port) => (
        <Text key={port.name}>
          {`${port.name}:${port.port} `}
          {port.live ? <Text color="green">●</Text> : <Text dimColor>○</Text>}
          {" "}
        </Text>
      ))}
      {target.needsState ? <Text color="yellow">{`state not applied (${target.needsState})`}</Text> : null}
    </Text>
  );
}

function DetailPane({ project, row, statusText }: { project: InventoryProject; row: Row; statusText: string[] | null }) {
  const target = row.target;
  if (!target) {
    return (
      <Box flexDirection="column">
        <Text>{`${project.name} slot ${row.slot}  `}<Text dimColor>no instance — press p to plant one</Text></Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>{row.isSource ? `${project.name} (source, slot 0)` : `${project.name}/${target.name}`}</Text>
        <Text>{`  ${target.path}  `}</Text>
        <Text dimColor>{`session ${target.tmuxSession}`}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>repos   </Text>
        {target.repos.length ? target.repos.map(formatGitState).join(" · ") : "(no repos declared)"}
      </Text>
      {statusText ? (
        statusText.map((line, lineIndex) => (
          <Text key={lineIndex} wrap="truncate-end">
            <Text dimColor>{lineIndex === 0 ? "status  " : "        "}</Text>
            {line}
          </Text>
        ))
      ) : (
        <Text>
          <Text dimColor>status  </Text>
          <Text dimColor>(press t)</Text>
        </Text>
      )}
    </Box>
  );
}

function ActionPane({ action }: { action: ActionState }) {
  const elapsed = Math.round((Date.now() - action.startedAt) / 1000);
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
      {action.lines.map((line, lineIndex) => (
        <Text key={lineIndex} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function HelpPane() {
  return (
    <Box flexDirection="column">
      <Text bold>keys</Text>
      <Text>↑/k ↓/j move · 0-9 jump to slot · o switch to the slot's tmux session and exit</Text>
      <Text>p plant an empty slot · u uproot (confirms) · s start · S stop · r reset (confirms)</Text>
      <Text>t run the project's status verb · R git fetch every repo, then re-read</Text>
      <Text>q or Esc quit · Ctrl-C interrupts a running action, or quits when idle</Text>
      <Text dimColor>press any key to close</Text>
    </Box>
  );
}

/** Rebuild the registry-backed target a row stands for, refusing if the registry moved under us. */
function toGroveTarget(projectName: string, row: Row, target: InventoryTarget): GroveTarget {
  const project = loadRegistry().projects[projectName];
  if (!project) throw new Error(`project "${projectName}" is no longer registered — press R to re-read.`);
  if (row.isSource) return { project, projectName, root: target.path };
  const instance = project.instances.find((candidate) => candidate.name === target.name && candidate.slot === target.slot);
  if (!instance) throw new Error(`${projectName}/${target.name} is no longer registered — press R to re-read.`);
  return { project, projectName, root: target.path, instance };
}

function safeSettings(onError: (message: string) => void) {
  try {
    return loadSettings();
  } catch (error) {
    onError((error as Error).message);
    return null;
  }
}

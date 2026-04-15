import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { PortDef } from "./types.js";
import { CopyFromSourceSpec, InstallSpec, RepoSpec, GROVE_CONFIG_FILE } from "./config.js";

// ---------------------------------------------------------------------------
// Glob matching (minimal, no dependencies)
// ---------------------------------------------------------------------------

function expandBraces(pattern: string): string[] {
  const m = pattern.match(/\{([^}]+)\}/);
  if (!m) return [pattern];
  return m[1].split(",").flatMap((alt) => expandBraces(pattern.replace(m[0], alt)));
}

function segmentMatch(segment: string, pattern: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(segment);
}

function globPartsMatch(
  parts: string[],
  pi: number,
  pat: string[],
  gi: number,
): boolean {
  if (gi === pat.length) return pi === parts.length;
  if (pat[gi] === "**") {
    for (let i = pi; i <= parts.length; i++) {
      if (globPartsMatch(parts, i, pat, gi + 1)) return true;
    }
    return false;
  }
  if (pi >= parts.length) return false;
  if (!segmentMatch(parts[pi], pat[gi])) return false;
  return globPartsMatch(parts, pi + 1, pat, gi + 1);
}

/** Test a relative file path against a glob pattern (supports *, **, {a,b}). */
export function matchGlob(filePath: string, pattern: string): boolean {
  return expandBraces(pattern).some((p) =>
    globPartsMatch(filePath.split("/"), 0, p.split("/"), 0),
  );
}

/** Recursively list all files under `dir`, returning paths relative to `dir`. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Clone repos
// ---------------------------------------------------------------------------

export function cloneRepos(
  source: string,
  target: string,
  repos: Record<string, RepoSpec>,
): void {
  fs.mkdirSync(target, { recursive: true });

  for (const [repoName, spec] of Object.entries(repos)) {
    const srcRepo = path.join(source, repoName);
    const destRepo = path.join(target, repoName);
    const branch = spec.branch ?? "main";

    if (!fs.existsSync(path.join(srcRepo, ".git"))) {
      console.log(`  Skipping ${repoName} (not a git repo in source)`);
      continue;
    }

    let remoteUrl: string;
    try {
      remoteUrl = execSync(`git -C "${srcRepo}" remote get-url origin`, {
        encoding: "utf-8",
      }).trim();
    } catch {
      console.log(`  Skipping ${repoName} (no origin remote)`);
      continue;
    }

    console.log(`  Cloning ${repoName} → ${branch} ...`);
    const submoduleFlag = spec.recurseSubmodules ? " --recurse-submodules" : "";
    execSync(
      `git clone -b "${branch}"${submoduleFlag} "${remoteUrl}" "${destRepo}" --quiet`,
      { stdio: "inherit" },
    );
  }
}

// ---------------------------------------------------------------------------
// Copy files from source
// ---------------------------------------------------------------------------

export function copyFromSource(
  source: string,
  target: string,
  specs: CopyFromSourceSpec[],
  portDefs: Record<string, PortDef>,
  slot: number,
): void {
  for (const spec of specs) {
    const src = path.join(source, spec.from);
    const dest = path.join(target, spec.to ?? spec.from);

    if (!fs.existsSync(src)) {
      console.log(`  Skipping copy: ${spec.from} (not found in source)`);
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      execSync(`cp -r "${src}" "${dest}"`, { stdio: "inherit" });
    } else {
      fs.copyFileSync(src, dest);
    }
    console.log(`  Copied ${spec.from}`);

    if (spec.patchPorts) {
      if (stat.isDirectory()) {
        const files = walkDir(dest);
        for (const file of files) {
          patchPortsInFile(file, portDefs, slot);
        }
      } else {
        patchPortsInFile(dest, portDefs, slot);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Port patching
// ---------------------------------------------------------------------------

/**
 * Build port replacement pairs from port definitions.
 * For each port, replaces the base number with the computed number wherever
 * the base appears as a standalone number (not part of a larger number).
 */
function buildPortReplacements(
  portDefs: Record<string, PortDef>,
  slot: number,
): Array<{ base: number; computed: number; regex: RegExp }> {
  const replacements: Array<{ base: number; computed: number; regex: RegExp }> = [];
  const seen = new Set<number>();

  for (const def of Object.values(portDefs)) {
    if (seen.has(def.base)) continue;
    seen.add(def.base);
    const computed = def.base + slot * def.offset;
    if (computed === def.base) continue; // slot 0 — nothing to replace
    replacements.push({
      base: def.base,
      computed,
      regex: new RegExp(`(?<!\\d)${def.base}(?!\\d)`, "g"),
    });
  }
  return replacements;
}

function patchPortsInFile(
  filePath: string,
  portDefs: Record<string, PortDef>,
  slot: number,
): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  const replacements = buildPortReplacements(portDefs, slot);
  let patched = content;
  for (const r of replacements) {
    patched = patched.replace(r.regex, String(r.computed));
  }

  if (patched !== content) {
    fs.writeFileSync(filePath, patched, "utf-8");
    return true;
  }
  return false;
}

/**
 * Patch port references in all files matching the given glob patterns.
 * Automatically skips grove's own config.json to avoid rewriting base definitions.
 */
export function patchPorts(
  target: string,
  globs: string[],
  portDefs: Record<string, PortDef>,
  slot: number,
): void {
  const allFiles = walkDir(target);
  let patchedCount = 0;

  for (const absPath of allFiles) {
    const rel = path.relative(target, absPath);

    // Never patch grove's own config — it stores base port definitions
    if (rel === GROVE_CONFIG_FILE) continue;

    const matches = globs.some((g) => matchGlob(rel, g));
    if (!matches) continue;

    if (patchPortsInFile(absPath, portDefs, slot)) {
      patchedCount++;
    }
  }

  console.log(`  Patched ports in ${patchedCount} file(s)`);
}

// ---------------------------------------------------------------------------
// Install dependencies
// ---------------------------------------------------------------------------

export function runInstalls(target: string, specs: InstallSpec[]): void {
  for (const spec of specs) {
    const dir = path.join(target, spec.dir);
    if (!fs.existsSync(dir)) {
      console.log(`  Skipping install in ${spec.dir} (directory not found)`);
      continue;
    }

    console.log(`  Installing in ${spec.dir}...`);
    for (const cmd of spec.cmds) {
      try {
        execSync(cmd, { stdio: "inherit", cwd: dir });
      } catch {
        console.error(`  Warning: command failed in ${spec.dir}: ${cmd}`);
      }
    }
    console.log(`  ${spec.dir} ready`);
  }
}

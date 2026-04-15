# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Grove is a CLI tool (`@crouton-kit/grove`) for managing parallel, isolated instances of a project with automatic slot-based port allocation. Each instance gets a slot (1-9) and ports are computed as `base + slot * offset`, preventing collisions when running multiple copies simultaneously.

## Commands

```bash
pnpm install               # Install dependencies
pnpm build                 # Compile TypeScript → dist/
npm run dev -- <cmd>       # Run CLI directly via tsx (no build needed)
npm run dev -- list        # Example: list all instances
```

No test framework is configured. Test manually:
```bash
npm run dev -- register /some/path --port core:3000:100
npm run dev -- plant myproject test-env
npm run dev -- list myproject
npm run dev -- uproot myproject/test-env --force
npm run dev -- doctor
```

## Architecture

**Registry-centric**: All state lives in `~/.grove/grove.json`. Commands follow load → mutate → save pattern via `loadRegistry()`/`saveRegistry()` in `src/registry.ts`.

**Source layout**:
- `src/cli.ts` — Commander.js entry point, wires all six commands
- `src/types.ts` — Core interfaces: `PortDef`, `GroveInstance`, `GroveProjectConfig`, `GroveRegistry`
- `src/config.ts` — Reads `.claude/grove/config.json` from project repos; exports `loadRepoConfig()`, `hasSetupScript()`, `GroveRepoConfig`
- `src/registry.ts` — Registry I/O + `nextFreeSlot()` helper
- `src/ports.ts` — `computePort()`, `computePorts()`, `checkPort()` (TCP health check)
- `src/commands/` — One file per command: register, plant, uproot, list, adopt, doctor

**Key behaviors**:
- `plant` outputs a `--- grove-output ---` JSON block for structured machine consumption
- `plant` symlinks `commands/plant.md` into the new instance's `.claude/commands/` directory
- `plant` auto-runs `.claude/grove/setup.sh` when present, passing `GROVE_PORT_*` env vars with computed ports
- `register --from-config` reads port definitions from `.claude/grove/config.json`; `--update` allows re-registration
- `adopt` auto-detects slot by reverse-computing from PORT= in `.env` files
- Default cloning uses rsync with exclusions (node_modules, .next, dist, .turbo, .cache, *.tsbuildinfo); projects can provide a custom init script or `.claude/grove/setup.sh`

## Portable Config (`.claude/grove/`)

Projects can store grove configuration in their repo at `.claude/grove/` (tracked in git) so any team member can plant without re-discovering ports:

- `config.json` — port definitions, repo specs, copy/patch/install declarations (schema version 1)
- `setup.sh` — optional post-plant script for custom logic that config can't express

The `/grove:seed` slash command generates both files. After committing them, `/grove:plant` skips discovery entirely.

**Config-driven setup fields** (all optional, processed in order by `grove plant`):
- `repos` — multi-repo clone definitions: `{ "name": { "branch": "dev", "recurseSubmodules": true } }`. Replaces rsync for multi-repo projects.
- `copyFromSource` — files/dirs to copy from source instance: `[{ "from": "path", "to": "path", "patchPorts": true }]`. For untracked files (`.env`, `.yalc`, `dist/`) that git clone won't include.
- `patchPortsIn` — glob patterns for automatic port substitution: `[".claude/**/*.md", "**/.env"]`. Replaces base port numbers with computed ports using `(?<!\d)BASE(?!\d)` regex. Skips `grove/config.json`.
- `install` — per-directory install commands: `[{ "dir": "subproject", "cmds": ["pnpm install"] }]`

`setup.sh` runs last after all config-driven steps. All context is passed via env vars: `GROVE_SOURCE`, `GROVE_TARGET`, `GROVE_SLOT`, `GROVE_INSTANCE_NAME`, `GROVE_PORTS_JSON`, and `GROVE_PORT_*` for each computed port.

## CI/CD

Push to `main` triggers `.github/workflows/publish.yml`:
1. Bumps patch version (`npm version patch`)
2. Builds and publishes to npm as `@crouton-kit/grove`
3. Skips if commit message starts with `chore: release`

## Companion Plugin

The crouton-kit plugin at `/Users/silasrhyneer/Code/crouton-kit/plugins/grove` wraps this CLI for Claude Code:
- `commands/` — Seven slash commands (`/grove:seed`, `/grove:plant`, `/grove:register`, etc.) that delegate to the `grove` binary
- `hooks/check-grove.sh` — SessionStart hook that verifies the CLI is installed globally
- `.claude-plugin/plugin.json` — Plugin metadata

**Two-step workflow:** `/grove:seed` discovers ports and generates `.claude/grove/` config (one-time, committed to git). `/grove:plant` uses that config for zero-discovery planting. For unseeded projects, `/grove:plant` falls back to full discovery.

When modifying CLI output format or adding commands, the plugin commands may need corresponding updates.

## Port Discovery Gotchas

When the `/grove:plant` slash command analyzes a codebase for ports, these are the non-obvious locations where port references hide and break parallel instances:

- `.claude/commands/*.md` — slash commands with hardcoded ports in examples and verification steps
- `.claude/scripts/*.sh` — automation scripts (kill_on_port, lsof, curl checks)
- `.claude/**/*.{md,json,yaml}` — skills, rules, docs, pipeline configs
- `tenant-config.json` — runtime configs with dashboard/API/chat URLs
- OAuth callback URLs and redirect URIs
- CORS origin lists (`CORS_ORIGINS=`)
- Vite/webpack proxy configs with hardcoded `target: 'http://localhost:NNNN'`
- Docker Compose `ports:` host mappings
- Electron deep link protocol schemes and CDP `remote-debugging-port` in package.json
- Hardcoded TypeScript constants (`const PORT = 3071`)
- `NEXT_PUBLIC_*` env vars with port-bearing URLs
- Package.json scripts referencing specific ports (`lsof -i :3068`)

## Conventions

- ESM-only (`"type": "module"`); all imports use `.js` extensions even for `.ts` sources
- Strict TypeScript, target ES2022, Node16 module resolution
- Each command defines an `interface XxxOptions` for typed option parsing
- Errors go to `console.error()` + `process.exit(1)`
- Slots constrained to 1-9; auto-assigned by `nextFreeSlot()`

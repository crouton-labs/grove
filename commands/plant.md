---
description: Create a new parallel instance from this already-registered project
allowed-tools: Bash(*), Read, Glob, Grep, Agent
argument-hint: <instance-name> [--slot N]
---

# Grove Plant (from instance)

**Arguments:** $ARGUMENTS

You're running this from inside a grove-managed instance. Use `grove list` to find the project name, then plant a new sibling instance.

## Step 1: Identify project

```bash
grove list
```

Find the project that owns the current directory.

## Step 2: Plant

```bash
grove plant <project> $ARGUMENTS
```

Parse the `--- grove-output ---` JSON block for `target`, `slot`, `ports`, and `source`.

If the project has `.claude/grove/setup.sh`, the CLI ran it automatically during planting — most post-plant configuration is already done. Check the output for any setup script warnings.

## Step 3: Verify

Run these checks against the planted instance. Parse `ports` and `target` from the grove-output JSON.

### 3a. Check .env ports match slot

For each service directory with a `.env`, verify PORT values match the slot-computed ports:

```bash
grep -r '^PORT=' <target>/*/. .env 2>/dev/null
grep -r '^FURNACE_PORT=' <target>/northlight-furnace/.env 2>/dev/null
grep -r '^CDP_PORT=' <target>/northlight-agent/.env 2>/dev/null
```

Cross-reference with `ports` from grove-output. Flag mismatches.

### 3b. Check for stale base port references in .claude/

Search for base ports (from grove registry) in `.claude/` scripts, docs, and config:

```bash
# Check for un-patched base ports (e.g., :3068, :3069, :8080, :9222)
grep -rn ':<base_port>' <target>/.claude/ 2>/dev/null
```

### 3c. Verify node_modules exist

Every service directory with a `package.json` must have `node_modules/`. Check ALL of them — including sub-directories like `proof-gallery/`:

```bash
find <target> -name package.json -not -path '*/node_modules/*' -exec sh -c \
  'dir=$(dirname "{}"); [ -d "$dir/node_modules" ] || echo "MISSING: $dir/node_modules"' \;
```

### 3d. Verify services can start

Start services with the headless script and check logs for immediate crashes:

```bash
<target>/.claude/scripts/headless.sh
sleep 10
# Check each port from grove-output
for port in <each port>; do
  lsof -i :$port -sTCP:LISTEN >/dev/null 2>&1 && echo ":$port OK" || echo ":$port FAILED"
done
# Check for crashes
grep -l 'GAVE UP\|EADDRINUSE\|Cannot find module' /tmp/northlight-*.log /tmp/proof-gallery-*.log 2>/dev/null
```

### 3e. Common failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `EADDRINUSE` | Source instance running on same port, or hardcoded port in source code | Kill conflicting process or patch the hardcoded port |
| `command not found` / `node_modules missing` | `pnpm install` was skipped | Run `pnpm install` in that service dir |
| `Invalid enum value` | Env value case mismatch after copy | Check validation schema and fix .env value casing |
| `Cannot find module` | Missing install in sub-directory or extension dir | Run `pnpm install` in the specific sub-directory |

## Step 4: Manual setup (only if no setup.sh)

If the project does NOT have a setup script (init script or `.claude/grove/setup.sh`), handle post-plant setup manually:

1. **Patch .env files** — update `PORT=`, `*_URL=`, `DATABASE_URL` with slot-computed ports
2. **Patch .claude/ files** — find-and-replace base port references with slot ports across `.md`, `.sh`, `.json`, `.yaml` files in `.claude/`
3. **Patch config files** — `tenant-config.json`, `docker-compose.yml`, etc.
4. **Patch source code** — search for hardcoded port numbers in application code (not just config)
5. **Install dependencies** — run package manager install in ALL directories with `package.json`, including sub-directories
6. **Run codegen** — prisma generate, migrations, etc.

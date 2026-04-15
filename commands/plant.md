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

- Check `.env` ports match slot-computed values
- Check no stale base port references remain in `.claude/` files:
  ```bash
  grep -rl ':<base_port>' <target>/.claude/ 2>/dev/null
  ```
- Confirm `node_modules` present in service directories

## Step 4: Manual setup (only if no setup.sh)

If the project does NOT have `.claude/grove/setup.sh`, handle post-plant setup manually:

1. **Patch .env files** — update `PORT=`, `*_URL=`, `DATABASE_URL` with slot-computed ports
2. **Patch .claude/ files** — find-and-replace base port references with slot ports across `.md`, `.sh`, `.json`, `.yaml` files in `.claude/`
3. **Patch config files** — `tenant-config.json`, `docker-compose.yml`, etc.
4. **Install dependencies** — run package manager install per service directory
5. **Run codegen** — prisma generate, migrations, etc.

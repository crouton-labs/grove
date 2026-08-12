# Grove

Grove manages parallel project instances with isolated slot-based ports. Each registered project defines ports as `base + slot × offset`; `grove plant` clones or copies the project, applies the slot configuration, installs dependencies, and runs the project setup script.

## Development

```bash
pnpm install
pnpm build
pnpm dev -- --help
```

## Project configuration

`grove register` reads `.grove/config.json` by default. Composite workspaces can keep the definition in their owning repository and pass its path relative to the registered source root:

```bash
grove register /path/to/workspace --config northlight/.grove/config.json
```

The selected config path is stored in `~/.grove/grove.json`. An optional `setup.sh` beside the selected config runs after the instance has been copied or cloned. Teardown runs when the config names `teardownScript`.

A version 1 config can define:

- `name` and `instancesDir`
- slot-based `ports`
- `aliases` for instance directories
- `repos` to clone into a composite instance
- `copyFromSource` for untracked local configuration
- `patchPortsIn` globs
- per-repository `install` commands
- `teardownScript`
- `devCommand`, an optional executable path relative to the target root (for example `scripts/dev.sh` or `northlight/scripts/dev.sh`)

`devCommand` must point to an existing regular executable file inside the project root. Grove validates it during registration, doctor checks, and dispatch; it does not guess a script path.

## Commands

```bash
grove register <source> [--config <relative-path>] [--update]
grove dev [raw argv...]
grove plant <project> [name] [--slot <n>]
grove adopt <project> <name> <path> [--slot <n>]
grove list [project]
grove doctor [project]
grove uproot <project/name> [--force]
```

`grove dev` resolves the current directory to the longest containing registered source or instance, then directly runs that target's configured `devCommand`. Arguments are forwarded unchanged, and Grove supplies `GROVE_SOURCE`, `GROVE_TARGET`, `GROVE_SLOT`, `GROVE_INSTANCE_NAME`, `GROVE_PORTS_JSON`, and `GROVE_PORT_<NAME>` environment variables.

`grove plant` prints a `--- grove-output ---` JSON block for callers that need the created path, slot, and ports.

Grove does not infer a moved config path. Re-run `grove register <source> --config <relative-path> --update`; config-backed re-registration replaces stored ports, aliases, init, teardown, and development-command values.

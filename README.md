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
- `secrets`, per-repository commands that materialize untracked configuration in the target
- `devCommand`, an optional executable path relative to the target root (for example `scripts/dev.sh` or `northlight/scripts/dev.sh`)
- `stateCommand`, an optional executable path with the same shape, giving the project a data-state layer

`devCommand` and `stateCommand` must each point to an existing regular executable file inside the project root. Grove validates them during registration, doctor checks, and dispatch; it does not guess a script path.

`secrets` takes the same `{ dir, cmds }` shape as `install` and runs in the target after `copyFromSource` and before `patchPortsIn`, so a generated `.env` gets its ports rewritten exactly like a copied one. Unlike `install`, a failing secrets command aborts the plant — a missing secret otherwise surfaces much later as an unexplained runtime failure.

```json
"secrets": [
  { "dir": "northlight/apps/core", "cmds": ["op inject -i .env.tpl -o .env"] }
]
```

## State

Ports, namespaces, and env files are an instance's identity; its database contents are state. `stateCommand` lets a project choose what state a new instance starts from and return a live instance to a known one. Grove owns the store, the ref grammar, and the schema gate; the project owns what its state actually is.

Grove invokes the executable with cwd at the target root and the same context environment `devCommand` gets. Non-zero exit fails the operation.

| invocation | contract |
|---|---|
| `state.sh reset` | bring this instance to the empty/migrated baseline |
| `state.sh capture <dir>` | write everything constituting this instance's state into `<dir>` (grove creates it empty) |
| `state.sh restore <dir>` | load a previously captured `<dir>` back into this instance |
| `state.sh fingerprint` | print one opaque line identifying the schema generation |

One ref grammar is shared by `plant --from` and `restore`:

- `baseline` — runs `reset`; this is the `plant` default and reproduces a project's pre-state-layer behavior
- `@<instance>` — captured live from that instance at the moment of use; `@source` means the project source at slot 0
- `<name>` — a snapshot in the store

Snapshots live in `~/.grove/states/<project>/<name>/`, holding `meta.json` and whatever `capture` wrote into `data/`. They are project-scoped, so uprooting the instance a snapshot came from leaves the snapshot intact.

`capture` records the `fingerprint` output; `restore` runs `fingerprint` against the destination and refuses on mismatch, naming both values. `--ignore-fingerprint` overrides it.

## Commands

```bash
grove register <source> [--config <relative-path>] [--update]
grove dev [raw argv...]
grove plant <project> [name] [--slot <n>] [--from <ref>] [--ignore-fingerprint]
grove adopt <project> <name> <path> [--slot <n>]
grove list [project]
grove doctor [project]
grove uproot <project/name> [--force]
grove snapshot <project/instance> <name> [--force]
grove restore <project/instance> <ref> [--force] [--ignore-fingerprint]
grove states [project] [--rm <name>]
```

`grove restore <project/instance> baseline` is the reset path; there is no separate reset verb.

`grove dev` resolves the current directory to the longest containing registered source or instance, then directly runs that target's configured `devCommand`. Arguments are forwarded unchanged, and Grove supplies `GROVE_SOURCE`, `GROVE_TARGET`, `GROVE_SLOT`, `GROVE_INSTANCE_NAME`, `GROVE_PORTS_JSON`, and `GROVE_PORT_<NAME>` environment variables.

`grove plant` prints a `--- grove-output ---` JSON block for callers that need the created path, slot, and ports.

Grove does not infer a moved config path. Re-run `grove register <source> --config <relative-path> --update`; config-backed re-registration replaces stored ports, aliases, init, teardown, and development-command values.

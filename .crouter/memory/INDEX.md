---
kind: knowledge
when-and-why-to-read: When working in the grove CLI — its commands, its config
  contract, or its state layer — this knowledge should be read because an
  ordinary-looking commit here publishes itself to npm on merge and rewrites
  machine-level files that live outside the repo and outside version control.
short-form: "@crouton-kit/grove — declarative parallel project instances with
  labels, ready pools, rollout, rollback, machine settings, and scoped env; tsc
  + tsx, no test suite; every push to main publishes; durable state lives in
  ~/.grove."
surfaces:
  - on: workspace-open
    at: content
  - on: read
    match: ./**
    at: content
last-updated: 2026-09-12T16:15:45.593Z
namespace: grove
---

# grove
`@crouton-kit/grove` — a published npm CLI (`grove`, bin `dist/cli.js`) that manages parallel project instances with isolated slot-based ports. It records declarative instance intent and applied revisions, supports labels and selectors, keeps ready pools for claim and release, and can roll a project fleet forward or roll one instance back. TypeScript, ESM, commander; `commander` is the only runtime dependency.

## Common commands

```bash
pnpm build            # tsc — the real gate
pnpm dev -- --help    # tsx src/cli.ts, run any verb against source
```

There is no test suite and no linter. Verification is `pnpm build` under `strict`, plus running `pnpm dev -- <verb>` against a genuinely registered project and reading what it did to `~/.grove`.

## Shipped surface

Read `README.md` for the current spec and applied-revision record, labels and selector targeting, ready pools with claim and release, rollout and rollback, machine settings and scoped env files, and pending-operation resolution. Use `grove <verb> -h` for command arguments and output; it is the current contract rather than this memory copying command mechanics.

## Rules

- **Every push to `main` publishes.** `.github/workflows/publish.yml` runs `npm version patch`, pushes a `chore: release v%s` commit and tag, builds, and `npm publish --access public`; it skips only commits whose message already starts with `chore: release`. Never bump `version` in `package.json` by hand — CI owns it, and a hand bump collides with the bot's own release commit — and never push to `main` as a step of testing a change, because that push IS a release.
- **The durable state is outside the repo and unversioned.** The registry is `~/.grove/grove.json` (`src/registry.ts`), snapshots are `~/.grove/states/<project>/<name>/` holding `meta.json` plus whatever the project's `capture` wrote into `data/`. Changing either shape migrates a live file on the machine that nothing else can restore — treat it as a schema change, not a refactor. A test harness must never delete, move, back up, or restore `~/.grove`: one did, storing its backup inside the fixture directory its own cleanup removed first, and the machine lost every snapshot, its settings, and its scoped env files with no way back. Register a fixture project alongside the real ones and tear it down with Grove's own verbs — a test never needs a pristine registry.
- **Node16 ESM:** relative imports carry `.js` extensions in the TypeScript source. `rootDir` is `src`, `outDir` is `dist`, `declaration` is on, and `dist/` is gitignored.
- **stdout is a caller-parsed channel.** `grove plant` prints a `--- grove-output ---` JSON block, and the update notice deliberately goes to stderr. Diagnostics never go to stdout.
- **Grove validates; it never guesses.** `devCommand` and `stateCommand` must each resolve to an existing regular executable inside the project root; a moved config path requires an explicit `grove register <source> --config <path> --update`; `restore` refuses on a `fingerprint` mismatch and names both values; `plant --code-from @source` refuses before any filesystem work when a source repo is dirty, missing, or cannot resolve `HEAD`. Preserve that shape — a half-built instance is worse than a refusal.

## Done

`pnpm build` clean, the changed verb exercised through `pnpm dev --` against a real project, and a conventional commit. Merging to `main` ships it to npm, so the commit is the release.

## Pointers

- `README.md` defines Grove's complete config contract, state-layer contract, shared state-reference grammar, declarative spec/applied record, labels/selectors, pools, rollout/rollback, machine settings, scoped env files, and pending resolution.
- One verb per file under `src/commands/`; shared concerns sit in `src/{config,registry,ports,state,context,process,paths}.ts`.

Every document in this store answers at `grove/<local name>`.

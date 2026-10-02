# Contributing to grove

Issues and pull requests are welcome at [github.com/crouton-labs/grove](https://github.com/crouton-labs/grove).

## Before you start

- **Bugs:** open an issue with the grove version (`grove --version`), your OS, and the command that failed with its output. For a problem with a project's `.grove/config.json`, include the config and the output of `grove doctor`.
- **Features and larger changes:** open an issue first, so the direction is agreed before you write the code.
- **Questions:** ask in [Discord](https://discord.gg/afwW4saEtr) or open an issue.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 22 or later (`engines` in `package.json`; the publish workflow builds on Node 24) and pnpm, which is the package manager behind the committed `pnpm-lock.yaml`. Some commands also need `git` and `tmux`.

```bash
git clone git@github.com:crouton-labs/grove.git
cd grove
pnpm install
pnpm build
```

`pnpm dev -- --help` runs the CLI from source with `tsx`, without building.

## Run the tests

There is no test suite and no linter yet. Before you push, run `pnpm build`, which type-checks the project with `tsc`, and try your change by hand with `pnpm dev -- <command>` against a scratch project.

## Pull requests

- Branch from the current `main`, and keep one change per pull request.
- Describe what changed and why in the pull request body, and say how you tried it.
- Update the [README](README.md) when you change a command, a flag, or the config format.
- Keep the history linear: rebase onto `main` rather than merging it into your branch.
- Commit messages follow the style of the existing log: a short imperative subject, with a prefix such as `fix(ui):` or `docs:` when it helps. Release commits (`chore: release vX.Y.Z`) are made by CI on every push to `main`, so do not bump the version yourself.

## Repository layout

| Path | Contents |
|---|---|
| [`src/`](src) | The CLI entry point, `cli.ts`, and the registry, config, port and state logic |
| [`src/commands/`](src/commands) | One module per `grove` command, including the `grove ui` terminal UI |
| [`assets/`](assets) | README images |

## License

grove is licensed under MIT. By contributing, you agree that your contribution is licensed under the same terms.

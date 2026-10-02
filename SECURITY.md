# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately, by email to **rhyneer.silas@gmail.com**. Do not open a public GitHub issue or pull request for a suspected vulnerability.

Include what you found, the version (`grove --version`) and platform, and the steps or a proof of concept that reproduce it. If the report involves a token or credential, redact it.

Reports are read by a single maintainer, and no response time is guaranteed. Fix timelines depend on severity and on what the fix involves. Say in your report if you want credit in the fix.

## Supported versions

Fixes land on `main` and ship in the next published release of [`@crouton-kit/grove`](https://www.npmjs.com/package/@crouton-kit/grove). Only the latest published version is supported.

## What is in scope

The code in this repository: the `grove` CLI and its state under `~/.grove`. Of particular interest:

- Secret env files (`~/.grove/env`, `~/.grove/env.d/`, `<target>/.grove/env`) having their values printed, logged, copied into an instance, or passed to a command they should not reach.
- A project config or a registry entry making grove read, write or delete files outside the registered source, the instance directory or `~/.grove`.

grove runs the scripts a project's `.grove/config.json` names (setup, install, secrets, dev, lifecycle and teardown commands) with your user's permissions. That is what it is for, not a vulnerability. Register and plant only projects you trust.

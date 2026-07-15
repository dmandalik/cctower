# cctower

Control tower for Claude Code — pre-flight token checks, attention alerts, and
landing reports. Local only: no API keys, no accounts, no network calls. It
reads Claude Code's own telemetry through lifecycle hooks and a statusline, and
never intercepts or slows your session.

## Install

```sh
npm install -g cctower      # or run from a clone: node bin/cctower.js
cctower init --dry-run      # preview the settings.json changes
cctower init                # register hooks + statusline (backs up first)
```

`init` merges cctower's entries into `~/.claude/settings.json` idempotently —
running it twice changes nothing, and your own hooks are left untouched. The
previous file is backed up under `~/.cctower/backups/` first.

## Status

```sh
cctower status
```

Shows the state dir, mode, whether cctower is registered, the last statusline
snapshot, and the current estimator correction factor.

## Uninstall

```sh
cctower uninstall
```

Removes only cctower's entries and prints the newest settings backup to restore
from if you want it.

## State

Everything lives under `$CCTOWER_HOME` (default `~/.cctower/`). Set
`CCTOWER_HOME` to relocate or isolate it — the whole tool is contained there.

## Roadmap

Estimator + pre-flight gate · attention notifications · landing "done ≠
correct" reports · local UI panel · weekly report.

## License

MIT

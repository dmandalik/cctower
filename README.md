# cctower

Control tower for Claude Code — pre-flight token checks, attention alerts, and
landing reports. Local only: no API keys, no accounts, no network calls. It
reads Claude Code's own telemetry through lifecycle hooks and a statusline, and
never intercepts or slows your session.

Three jobs:

- **Pre-flight gate** — estimates what a prompt will cost (tokens, context,
  quota) before it runs, flags weak prompts, and self-tunes against real usage.
- **Attention alerts** — desktop notifications when a session finishes or needs
  input.
- **Landing reports** — a "done ≠ correct" review card when a run ends: what
  changed, what was tested vs. merely claimed, what to verify.

<!-- demo GIF placeholder: drop a recording of `cctower ui` here before publishing -->

## Install

```sh
npm install -g cctower
cctower init --dry-run
cctower init
```

`init` merges cctower's entries into `~/.claude/settings.json` idempotently —
running it twice changes nothing, and your own hooks are left untouched. The
previous file is backed up under `~/.cctower/backups/` first. `--dry-run`
prints the exact diff and touches nothing.

## Commands

```sh
cctower status       # state-dir + install health, estimator accuracy
cctower ui           # local cockpit panel (quota, sessions, landing cards)
cctower report       # 7-day summary: verdicts, idle time, top lint findings
cctower uninstall    # remove only cctower's entries; prints the newest backup
```

## Modes

Set `mode` in `~/.cctower/config.json`:

- `observe` — log only.
- `advise` (default) — print a compact pre-flight line; silent on trivial
  prompts.
- `gate` — block a prompt when projected context/quota crosses a threshold;
  resend with `!force` in the prompt to override.

## State

Everything lives under `$CCTOWER_HOME` (default `~/.cctower/`). Set
`CCTOWER_HOME` to relocate or isolate it — the whole tool is contained there.

## License

MIT

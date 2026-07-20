# cctower

A **turn auditor for Claude Code** with a live status widget. After every
turn, cctower reads the transcript and writes a "done ≠ correct" landing
report: what changed, what was actually tested versus merely claimed, and a
verdict — `VERIFIED` · `UNVERIFIED` · `FAILED` · `NO-OP`. If Claude says
"tests pass" but never ran them, the card says so.

Local only: no API keys, no accounts, no network calls. cctower attaches
through Claude Code's lifecycle hooks and statusline, never intercepts or
slows a session, and fails open on any internal error.

## What you get

- **Landing reports** — per-turn markdown cards with files touched, git diff
  stats, test/build runs and exit codes, new TODO/FIXMEs, claims checked
  against reality, and a verdict.
- **Live widget** (`cctower ui`) — a compact local panel: per-session status
  orbs (working · needs input · issue · done), an alert bar + title flash when
  any chat needs you, the latest landing cards, the last pre-flight readout,
  and controls (mode, alerts, thresholds, per-project mute). The widget
  process is also the stall watcher: Claude Code fires no hook while a
  permission or question dialog is open, so mid-turn needs-input detection
  works while the widget is running.
- **Pre-flight gate** — estimates each prompt's token cost, projects context
  use, lints weak prompts, and can block (`gate` mode, `!force` to override).
  Self-tunes against real usage.
- **Best-effort extras** — desktop notifications and quota readouts, with
  platform limits stated plainly below.

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
cctower ui           # live widget (sessions, cards, controls)
cctower report       # 7-day summary: verdicts, idle time, top lint findings
cctower uninstall    # remove only cctower's entries; prints the newest backup
```

## Modes

Set `mode` in `~/.cctower/config.json` or from the widget:

- `observe` — log only.
- `advise` (default) — print a compact pre-flight line; silent on trivial
  prompts.
- `gate` — block a prompt when projected context/quota crosses a threshold;
  resend with `!force` in the prompt to override.

Note: in GUI clients (desktop app, IDE) the pre-flight advise line is injected
into the model's context but not shown to you — the widget's "last pre-flight"
row and the statusline are the user-facing surfaces.

## Known platform limits

- **macOS may suppress scripted notification banners.** cctower posts via
  `terminal-notifier` when you've installed it (optional, auto-detected — not
  a dependency), else via `osascript` (shows as "Script Editor"). For banners:
  System Settings → Notifications → allow the posting app and set its style to
  **Alerts** or **Banners**; check that no Focus mode is active. Even then,
  recent macOS versions sometimes deliver scripted notifications silently to
  Notification Center. The widget and its sound ping are the reliable surface.
- **Quota is best-effort.** Claude Code only exposes `rate_limits` to the
  statusline on some versions. When present, cctower shows official
  percentages; when absent, it shows token volume aggregated from your local
  transcripts over rolling 5-hour/7-day windows, tagged "local estimate" (no
  percentage — plan limits aren't knowable locally).
- **Claude Code only.** cctower attaches via local hooks, so it covers the
  CLI, desktop app, and IDE sessions — not claude.ai web chats, which run no
  local hooks.

## State

Everything lives under `$CCTOWER_HOME` (default `~/.cctower/`). Set
`CCTOWER_HOME` to relocate or isolate it — the whole tool is contained there.

## License

MIT

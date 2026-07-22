#!/usr/bin/env node
'use strict';

// The stall watcher daemon. Claude Code fires no hook while a permission or
// question dialog is open, and the desktop app doesn't reliably run the
// statusline — so nothing long-lived exists to notice a stalled chat. This
// tiny detached process is that sensor: spawned by the gate on each prompt
// (if not already alive via pidfile), it polls the session files every 2s
// through stallwatch, and exits on its own after 10 quiet minutes. The gate
// respawns it the next time you prompt, so it runs exactly when you're
// actively using Claude. Local only; fail open; no network.

const fs = require('fs');
const path = require('path');
const { statePaths } = require('../paths');
const { checkAll } = require('../stallwatch');

const POLL_MS = Number(process.env.CCTOWER_WATCH_MS) || 2000;
const IDLE_EXIT_MS = Number(process.env.CCTOWER_WATCH_IDLE_MS) || 10 * 60_000;

function pidFile() {
  return path.join(statePaths().home, 'watcher.pid');
}

function main() {
  const pf = pidFile();
  fs.mkdirSync(path.dirname(pf), { recursive: true });
  fs.writeFileSync(pf, String(process.pid));

  let lastActive = Date.now();
  const tick = () => {
    try {
      // Newest daemon wins: if another instance took the pidfile, bow out.
      // An unreadable pidfile (state dir deleted) also means exit — otherwise
      // a throw here would skip the idle-exit forever.
      let owner = null;
      try {
        owner = fs.readFileSync(pf, 'utf8').trim();
      } catch {
        process.exit(0);
      }
      if (owner !== String(process.pid)) process.exit(0);
      const active = checkAll();
      if (active > 0) lastActive = Date.now();
      if (Date.now() - lastActive > IDLE_EXIT_MS) {
        try {
          fs.unlinkSync(pf);
        } catch {
          /* already gone */
        }
        process.exit(0);
      }
    } catch {
      /* one bad tick must not kill the sensor */
    }
  };
  tick();
  setInterval(tick, POLL_MS);
}

try {
  main();
} catch {
  process.exit(0); // fail open
}

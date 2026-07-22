'use strict';

// Shared mid-turn stall detection. Claude Code fires NO hook while a
// permission dialog or AskUserQuestion is on screen — the turn just stalls.
// But the transcript shows it: a pending tool_use and a file that stopped
// growing. Whoever polls (the watcher daemon, the widget server) calls
// checkSession() for each active session; it owns the state transition, the
// notification, and the dedupe, all recorded in the session file so multiple
// pollers stay consistent.
//
// Accuracy rules, in order:
//   - AskUserQuestion pending        -> waiting immediately (it runs no code).
//   - other tool pending, file quiet -> waiting ONLY if the command is not
//     visible in the process table (a running `ps` entry means it is still
//     executing, no matter how quiet the transcript is).
//   - interruption markers, sibling results, or any later user entry kill
//     "pending" entirely (handled in transcript.pendingToolUses).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { statePaths } = require('./paths');
const { readJson, writeJson, loadConfig } = require('./state');
const { notify } = require('./notify');
const { looksLongRunning } = require('./card');
const T = require('./transcript');

const STALL_MS = 15_000; // quiet time before a pending tool counts as stalled
const ASK_MS = 3_000; // AskUserQuestion needs only a settle delay
const RESUME_MS = 3_000; // fresh writes mean the turn is moving again
const DEDUPE_MS = 30_000;
const REMIND_MS = 5 * 60_000; // still waiting after 5 min -> one reminder

// Is a command from a pending Bash tool_use visible in the process table?
// Overridable for tests via CCTOWER_FAKE_PS (a plain string of fake ps output).
function commandRunning(cmd) {
  const needle = String(cmd || '').split('\n')[0].trim().slice(0, 80);
  if (!needle) return false;
  try {
    const table =
      process.env.CCTOWER_FAKE_PS != null
        ? process.env.CCTOWER_FAKE_PS
        : execFileSync('ps', ['-axo', 'command'], { timeout: 2000 }).toString();
    return table.includes(needle);
  } catch {
    return false; // can't tell -> fall through to the heuristics
  }
}

// Cheap per-file analysis, cached inside the session file keyed by transcript
// mtime, so repeated polls (and separate poller processes) parse at most once
// per transcript change.
function pendingInfo(sess, file, mtimeMs) {
  const cached = sess.stallCheck;
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const turn = T.sliceTurn(T.readTailEntries(file));
  const pend = T.pendingToolUses(turn);
  return {
    mtimeMs,
    ask: pend.some((u) => u.name === 'AskUserQuestion'),
    pendCmds: pend.filter((u) => u.name === 'Bash').map((u) => String(u.input.command || '')),
    pendQuick: pend.some((u) => u.name !== 'AskUserQuestion' && u.name !== 'Bash'),
    interrupted: T.hasInterruption(turn),
  };
}

// Check one session; returns the (possibly updated) session object.
function checkSession(id, sess, now = Date.now()) {
  const file = sess.transcriptPath;
  if (!file) return sess;
  const sessFile = path.join(statePaths().sessions, `${id}.json`);

  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return sess;
  }
  const quiet = now - mtimeMs;

  if (sess.state === 'working') {
    if (quiet < ASK_MS) return sess; // actively streaming — nothing to do
    const info = pendingInfo(sess, file, mtimeMs);
    if (info !== sess.stallCheck) {
      sess = { ...sess, stallCheck: info };
      writeJson(sessFile, sess); // persist the parse cache for other pollers
    }
    if (info.interrupted) return sess; // user is present — not waiting

    let stalled = false;
    let ask = false;
    if (info.ask) {
      stalled = true;
      ask = true;
    } else if (quiet >= STALL_MS) {
      if (info.pendQuick) stalled = true; // Edit/Write finish in <1s; quiet = dialog
      else if (info.pendCmds.length) {
        // Bash: trust the process table first; heuristics only when ps failed.
        stalled = !info.pendCmds.some((c) => commandRunning(c) || looksLongRunning(c));
      }
    }
    if (!stalled) return sess;

    const next = { ...sess, state: 'waiting', stall: true };
    if (typeof next.waitingSince !== 'number') next.waitingSince = now;
    maybeNotify(id, next, ask, now);
    writeJson(sessFile, next);
    return next;
  }

  if (sess.state === 'waiting' && sess.stall === true) {
    if (quiet < RESUME_MS) {
      // Approved/answered — the transcript is moving again.
      const next = { ...sess, state: 'working', stall: false };
      if (typeof next.waitingSince === 'number') {
        next.waitedSeconds =
          (next.waitedSeconds || 0) + Math.max(0, Math.round((now - next.waitingSince) / 1000));
        delete next.waitingSince;
      }
      writeJson(sessFile, next);
      return next;
    }
    // Still stalled: one reminder after REMIND_MS.
    if (
      typeof sess.lastNotifiedAt === 'number' &&
      now - sess.lastNotifiedAt >= REMIND_MS &&
      !sess.reminded
    ) {
      const next = { ...sess, reminded: true };
      maybeNotify(id, next, (sess.stallCheck || {}).ask === true, now, true);
      writeJson(sessFile, next);
      return next;
    }
  }
  return sess;
}

function maybeNotify(id, sess, ask, now, isReminder = false) {
  const cfg = loadConfig();
  const muted = Array.isArray(cfg.mutedProjects) && cfg.mutedProjects.includes(sess.project);
  const deduped =
    !isReminder && typeof sess.lastNotifiedAt === 'number' && now - sess.lastNotifiedAt < DEDUPE_MS;
  if (!cfg.notifications.needsInput || muted || deduped) return;
  const proj = sess.project || id;
  notify({
    title: ask ? `Claude is asking you a question · ${proj}` : `Claude needs permission · ${proj}`,
    message: isReminder
      ? 'Still waiting on you (5 min).'
      : ask
        ? 'A question dialog is waiting.'
        : 'A tool call is waiting for your approval.',
    urgent: !ask,
    sound: cfg.notifications.sound,
    group: id,
  });
  sess.lastNotifiedAt = now;
}

// Scan every session file and check the active ones. Returns count of
// sessions currently in a working/stalled state (the daemon's liveness input).
function checkAll(now = Date.now()) {
  const p = statePaths();
  let active = 0;
  let files;
  try {
    files = fs.readdirSync(p.sessions).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    const sess = readJson(path.join(p.sessions, f), {}) || {};
    if (sess.state !== 'working' && !(sess.state === 'waiting' && sess.stall === true)) continue;
    // A session with no live transcript can never stall — it must not keep
    // the daemon alive (that made orphaned daemons immortal).
    if (!sess.transcriptPath || !fs.existsSync(sess.transcriptPath)) continue;
    const after = checkSession(id, sess, now);
    if (after.state === 'working' || (after.state === 'waiting' && after.stall === true)) active++;
  }
  return active;
}

module.exports = { checkSession, checkAll, commandRunning, STALL_MS };

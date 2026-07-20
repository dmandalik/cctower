'use strict';

// Builds the /state JSON the UI polls. Read-only over the state dir; tolerant
// of missing files (a fresh install has almost nothing yet).

const fs = require('fs');
const path = require('path');
const { statePaths } = require('../paths');
const { readJson, writeJson, loadConfig } = require('../state');
const { accuracy } = require('../calibrate');
const { getQuota } = require('../quota');
const { notify } = require('../notify');
const { looksLongRunning } = require('../card');
const T = require('../transcript');

// ---- mid-turn stall watcher -------------------------------------------------
// Claude Code fires NO hook while a permission dialog or AskUserQuestion is on
// screen — the turn just stalls. But the transcript shows it: a tool_use with
// no tool_result and a file that stopped growing. The widget server polls
// every second, so it plays the role the Notification hook was supposed to:
// flip the session to waiting and send the needs-input notification.
const STALL_MS = 15_000; // quiet time before a pending tool counts as stalled
const RESUME_MS = 3_000; // fresh writes mean the turn is moving again
const DEDUPE_MS = 30_000;
const stallCache = new Map(); // transcriptPath -> { mtimeMs, info }

function stallInfo(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = stallCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return { ...hit.info, mtimeMs: st.mtimeMs };
  const turn = T.sliceTurn(T.readEntries(file));
  const pend = T.pendingToolUses(turn);
  const info = {
    ask: pend.some((u) => u.name === 'AskUserQuestion'),
    blocked: pend.some(
      (u) => u.name !== 'AskUserQuestion' && !(u.name === 'Bash' && looksLongRunning(u.input.command)),
    ),
  };
  stallCache.set(file, { mtimeMs: st.mtimeMs, info });
  return { ...info, mtimeMs: st.mtimeMs };
}

// Returns the (possibly updated) session object; writes + notifies on change.
function applyStallWatch(p, id, sess, now) {
  const file = sess.transcriptPath;
  if (!file) return sess;

  if (sess.state === 'working') {
    const info = stallInfo(file);
    if (!info) return sess;
    const quiet = now - info.mtimeMs;
    // An open AskUserQuestion dialog is waiting immediately (it executes no
    // code); an ordinary pending tool only counts after STALL_MS of quiet —
    // long-running commands (tests, installs) are exempt via looksLongRunning.
    const stalled = (info.ask && quiet > RESUME_MS) || (info.blocked && quiet > STALL_MS);
    if (!stalled) return sess;

    const next = { ...sess, state: 'waiting', stall: true };
    if (typeof next.waitingSince !== 'number') next.waitingSince = now;
    const cfg = loadConfig();
    const muted = Array.isArray(cfg.mutedProjects) && cfg.mutedProjects.includes(sess.project);
    const deduped = typeof sess.lastNotifiedAt === 'number' && now - sess.lastNotifiedAt < DEDUPE_MS;
    if (cfg.notifications.needsInput && !muted && !deduped) {
      const proj = sess.project || id;
      notify({
        title: info.ask ? `Claude is asking you a question · ${proj}` : `Claude needs permission · ${proj}`,
        message: info.ask ? 'A question dialog is waiting.' : 'A tool call is waiting for your approval.',
        urgent: !info.ask,
        sound: cfg.notifications.sound,
        group: id,
      });
      next.lastNotifiedAt = now;
    }
    writeJson(path.join(p.sessions, `${id}.json`), next);
    return next;
  }

  if (sess.state === 'waiting' && sess.stall === true) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return sess;
    }
    if (now - mtimeMs < RESUME_MS) {
      // Approved/answered — the transcript is moving again.
      const next = { ...sess, state: 'working', stall: false };
      if (typeof next.waitingSince === 'number') {
        next.waitedSeconds = (next.waitedSeconds || 0) + Math.max(0, Math.round((now - next.waitingSince) / 1000));
        delete next.waitingSince;
      }
      writeJson(path.join(p.sessions, `${id}.json`), next);
      return next;
    }
  }
  return sess;
}

// working (Claude processing) · waiting (needs input) · issue (FAILED) · done.
function sessionStatus(s) {
  if (s.state === 'working' || s.state === 'waiting' || s.state === 'issue' || s.state === 'done') {
    return s.state;
  }
  // Fallback for sessions written before the explicit state field.
  if (typeof s.waitingSince === 'number') return 'waiting';
  if (s.verdict === 'FAILED') return 'issue';
  if (s.verdict) return 'done';
  return 'working';
}

function readSessions(p, snapshot) {
  try {
    return fs
      .readdirSync(p.sessions)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const id = f.replace(/\.json$/, '');
        const s = applyStallWatch(p, id, readJson(path.join(p.sessions, f), {}) || {}, Date.now());
        const updated = fs.statSync(path.join(p.sessions, f)).mtimeMs;
        // Per-session context is only known for the session the statusline
        // last reported on; others show an empty mini-bar.
        const contextPct = snapshot && snapshot.session === id ? snapshot.contextPct : null;
        return {
          id,
          project: s.project || null,
          status: sessionStatus(s),
          verdict: s.verdict || null,
          contextPct,
          waitedSeconds: s.waitedSeconds || 0,
          updated,
        };
      })
      .sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

function readCards(p) {
  try {
    return fs
      .readdirSync(p.cards)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const fp = path.join(p.cards, f);
        const body = fs.readFileSync(fp, 'utf8');
        const grab = (re) => (body.match(re) || [])[1] || null;
        return {
          file: f,
          session: grab(/\*\*Session:\*\*\s*(.+)/),
          verdict: grab(/\*\*Verdict:\*\*\s*([\w-]+)/),
          when: grab(/\*\*When:\*\*\s*(.+)/),
          updated: fs.statSync(fp).mtimeMs,
          body,
        };
      })
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 12);
  } catch {
    return [];
  }
}

// Latest pre-flight readout for the widget (the advise line GUI clients
// inject into model context but never show the user). Primary source is the
// preflight.json the gate writes; the events-log scan covers state dirs
// written before that file existed.
function lastPreflight(p) {
  const direct = readJson(p.preflight);
  if (direct && direct.est) return direct;
  return lastGate(p);
}

function lastGate(p) {
  try {
    const lines = fs.readFileSync(p.events, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (e.event === 'gate') return { ts: e.ts, est: e.est, heavy: e.heavy, projected: e.projected, lint: e.lint };
    }
  } catch {
    /* no events yet */
  }
  return null;
}

function collectState() {
  const p = statePaths();
  const snapshot = readJson(p.snapshot);
  const cal = readJson(p.calibration) || {};
  const config = loadConfig();

  return {
    ts: new Date().toISOString(),
    mode: config.mode,
    config,
    preflight: lastPreflight(p),
    quota: getQuota(),
    snapshot: snapshot || null,
    estimator: {
      correction: typeof cal.correction === 'number' ? cal.correction : 1,
      accuracy: accuracy(cal),
      samples: (cal.pairs && cal.pairs.length) || 0,
    },
    sessions: readSessions(p, snapshot),
    cards: readCards(p),
  };
}

module.exports = { collectState, sessionStatus };

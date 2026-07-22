'use strict';

// Builds the /state JSON the UI polls. Read-only over the state dir; tolerant
// of missing files (a fresh install has almost nothing yet).

const fs = require('fs');
const path = require('path');
const { statePaths } = require('../paths');
const { readJson, writeJson, loadConfig } = require('../state');
const { accuracy } = require('../calibrate');
const { getQuota } = require('../quota');
const { checkSession } = require('../stallwatch');

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

// A session is LIVE only if its transcript (or, lacking one, its session
// file) saw activity inside the user's live window (Controls-adjustable).
// Everything older is a closed chat — there is no "session ended" hook, so
// staleness is the only honest signal.
function isLive(sessFilePath, sess, now, windowMs) {
  let liveAt = 0;
  try {
    liveAt = fs.statSync(sessFilePath).mtimeMs;
  } catch {
    return false;
  }
  if (sess.transcriptPath) {
    try {
      liveAt = Math.max(liveAt, fs.statSync(sess.transcriptPath).mtimeMs);
    } catch {
      /* transcript gone — fall back to session-file recency */
    }
  }
  return now - liveAt < windowMs;
}

// The app's chat title lives in ai-title entries that can sit anywhere in the
// transcript (the gate's tail read catches recent ones). Fallback: one full
// line-filtered scan, cached in the session file so it never repeats unless
// the transcript grows substantially.
function ensureTitle(p, id, sess) {
  if (sess.title || !sess.transcriptPath) return sess;
  let size;
  try {
    size = fs.statSync(sess.transcriptPath).size;
  } catch {
    return sess;
  }
  if (sess.titleScanSize && size < sess.titleScanSize * 2) return sess; // already scanned
  let title = null;
  try {
    const raw = fs.readFileSync(sess.transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.includes('"ai-title"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) title = e.aiTitle.trim();
      } catch {
        /* skip */
      }
    }
  } catch {
    return sess;
  }
  const next = { ...sess, titleScanSize: size };
  if (title) next.title = title;
  writeJson(path.join(p.sessions, `${id}.json`), next);
  return next;
}

function readSessions(p, snapshot) {
  const now = Date.now();
  const windowMs = Math.max(1, Math.min(24, loadConfig().liveWindowHours || 4)) * 3600_000;
  try {
    return fs
      .readdirSync(p.sessions)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => isLive(path.join(p.sessions, f), readJson(path.join(p.sessions, f), {}) || {}, now, windowMs))
      .map((f) => {
        const id = f.replace(/\.json$/, '');
        // Same stall logic the watcher daemon runs — shared module, session-
        // file dedupe, so double-polling never double-notifies.
        let s = checkSession(id, readJson(path.join(p.sessions, f), {}) || {});
        s = ensureTitle(p, id, s);
        const updated = fs.statSync(path.join(p.sessions, f)).mtimeMs;
        // Per-session context is only known for the session the statusline
        // last reported on; others show an empty mini-bar.
        const contextPct = snapshot && snapshot.session === id ? snapshot.contextPct : null;
        return {
          id,
          project: s.project || null,
          title: s.title || null,
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

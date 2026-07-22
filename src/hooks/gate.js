#!/usr/bin/env node
'use strict';

// Pre-flight gate (UserPromptSubmit). Estimates a prompt's cost, projects the
// resulting context %, lints the prompt, and acts by mode:
//   observe -> log only
//   advise  -> print one compact line to stdout (injected as context)
//   gate    -> exit 2 to block when projected context/quota cross thresholds
// Budget < 100ms. Fail open: any error -> exit 0, get out of the way.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { readStdinJson } = require('../io');
const { statePaths } = require('../paths');
const { loadConfig, readJson, writeJson, appendEvent } = require('../state');
const { notify } = require('../notify');
const { estimate, humanTokens } = require('../estimator');
const { lint, isHeavy } = require('../lint');
const T = require('../transcript');

// Prompts containing this token always pass the gate (override hint).
const FORCE = '!force';

// Keep the stall-watcher daemon alive: it is the only process that can catch
// a mid-turn permission/question dialog (no hook fires then). Pidfile check
// is a stat + signal-0 — microseconds; spawn is detached and unref'd so the
// gate never waits on it.
function ensureWatcher() {
  if (process.env.CCTOWER_NO_WATCHER) return; // tests opt out of the daemon
  try {
    const pf = path.join(statePaths().home, 'watcher.pid');
    try {
      const pid = Number(fs.readFileSync(pf, 'utf8').trim());
      if (pid > 0) {
        process.kill(pid, 0); // throws if dead
        return;
      }
    } catch {
      /* stale or missing pidfile -> spawn */
    }
    const child = spawn(process.execPath, [path.join(__dirname, 'watcher.js')], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    /* watcher is best-effort; the gate must never fail on it */
  }
}
const NOISE_FLOOR = 250; // below this (and nothing flagged) advise stays silent.

function gitRef(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function readTranscript(p) {
  try {
    if (p && fs.statSync(p).size < 4 * 1024 * 1024) return fs.readFileSync(p, 'utf8');
  } catch {
    /* absent or too big */
  }
  return '';
}

function correctionFactor() {
  const c = readJson(statePaths().calibration);
  return c && typeof c.correction === 'number' ? c.correction : 1;
}

// Build the advise line from whatever telemetry is available (feature-detect).
function adviseLine({ est, projected, snapshot, lintNote }) {
  const parts = [`~${humanTokens(est.low)}–${humanTokens(est.high)} tokens`];
  if (projected != null) parts.push(`context → ${projected}%`);
  if (snapshot && snapshot.quota && typeof snapshot.quota.fiveHourPct === 'number') {
    const q = snapshot.quota;
    const resets = q.fiveHourResets ? ` (resets ${q.fiveHourResets})` : '';
    parts.push(`5h quota ${q.fiveHourPct}%${resets}`);
  }
  let line = `[cctower] ${parts.join(' · ')}`;
  if (lintNote) line += `\n[cctower] ${lintNote}`;
  return line;
}

// Current context occupancy, best source first:
//   1. a FRESH statusline snapshot (terminal CLI keeps this alive),
//   2. the transcript itself — the last assistant response's input-side usage
//      IS the live window occupancy (works in the desktop app, where the
//      statusline never runs),
//   3. a stale snapshot, marked as such.
const SNAP_FRESH_MS = 10 * 60_000;
function liveContext(tailEntries, snapshot) {
  const size = (snapshot && snapshot.contextSize) || 200_000;
  const fresh =
    snapshot && snapshot.ts && Date.now() - Date.parse(snapshot.ts) < SNAP_FRESH_MS;
  if (fresh && typeof snapshot.contextPct === 'number') {
    return { pct: snapshot.contextPct, size, source: 'statusline' };
  }
  const tokens = T.lastContextTokens(tailEntries);
  if (tokens != null) {
    return { pct: Math.min(100, Math.round((tokens / size) * 100)), size, source: 'transcript' };
  }
  if (snapshot && typeof snapshot.contextPct === 'number') {
    return { pct: snapshot.contextPct, size, source: 'stale statusline' };
  }
  return null;
}

function run() {
  ensureWatcher();
  const input = readStdinJson();
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const forced = prompt.includes(FORCE);

  const cfg = loadConfig();
  const snapshot = readJson(statePaths().snapshot);
  const model = (snapshot && snapshot.model) || '';

  const est = estimate({ text: prompt, model, correction: correctionFactor() });
  const heavy = isHeavy(prompt, est.high);
  const tailEntries = T.readTailEntries(input.transcript_path || '');
  const ctx = liveContext(tailEntries, snapshot);
  const projected = ctx ? Math.min(100, Math.round(ctx.pct + (est.high / ctx.size) * 100)) : null;
  const chatTitle = T.lastAiTitle(tailEntries);

  const note = cfg.lint
    ? lint({ prompt, estHigh: est.high, heavy, model, transcript: readTranscript(input.transcript_path) })
    : null;
  const lintNote = note && note.note;

  // Record this turn for the landing report (git ref + estimate).
  let proj = input.cwd ? path.basename(String(input.cwd)) : undefined;
  if (input.session_id) {
    const file = path.join(statePaths().sessions, `${input.session_id}.json`);
    const prev = readJson(file, {}) || {};
    proj = proj || prev.project;
    writeJson(file, {
      ...prev,
      project: proj,
      title: chatTitle || prev.title, // the app's own chat name, when present
      state: 'working', // prompt submitted -> Claude is working
      stall: false,
      transcriptPath: input.transcript_path || prev.transcriptPath,
      lastPrompt: { ts: new Date().toISOString(), estimate: est, gitRef: gitRef(input.cwd) },
    });

    // Notify on the transition INTO working (not on the first prompt of a
    // brand-new session, and not on repeat working states).
    const muted = Array.isArray(cfg.mutedProjects) && cfg.mutedProjects.includes(proj);
    if (cfg.notifications.working && !muted && prev.state && prev.state !== 'working') {
      notify({ title: `▶ Claude working · ${proj}`, message: 'Started a turn', sound: cfg.notifications.sound, group: input.session_id });
    }
  }

  // Decide the gate outcome up front so the event log and the widget's
  // pre-flight row can both show WHY a prompt was blocked.
  let blockReason = null;
  if (cfg.mode === 'gate' && !forced) {
    const quotaPct = snapshot && snapshot.quota && snapshot.quota.fiveHourPct;
    if (projected != null && projected >= cfg.contextWarnPct) {
      blockReason = `projected context ${projected}% ≥ ${cfg.contextWarnPct}%`;
    } else if (typeof quotaPct === 'number' && quotaPct >= cfg.quotaWarnPct) {
      blockReason = `5h quota ${quotaPct}% ≥ ${cfg.quotaWarnPct}%`;
    }
  }

  // GUI clients never show hook stdout to the user (it reaches the model's
  // context only), so noteworthy pre-flight findings go out as notifications —
  // the one surface that reliably reaches the user before a bad decision.
  const ctxOver = projected != null && projected >= cfg.contextWarnPct;
  const mutedHint = Array.isArray(cfg.mutedProjects) && cfg.mutedProjects.includes(proj);
  if (cfg.notifications.advise !== false && !mutedHint) {
    const who = proj || 'chat';
    if (blockReason) {
      notify({
        title: `⛔ Prompt blocked · ${who}`,
        message: `${blockReason} — resend with !force to override`,
        urgent: true,
        sound: cfg.notifications.sound,
        group: input.session_id,
      });
    } else if (cfg.mode === 'advise' && (lintNote || ctxOver)) {
      notify({
        title: `💡 Pre-flight · ${who}`,
        message: lintNote || `Projected context ${projected}% ≥ ${cfg.contextWarnPct}% — consider /compact or a fresh chat`,
        sound: cfg.notifications.sound,
        group: input.session_id,
      });
    }
  }

  appendEvent({
    ts: new Date().toISOString(),
    event: 'gate',
    session: input.session_id || null,
    mode: cfg.mode,
    est: { low: est.low, high: est.high, content: est.content },
    heavy,
    projected,
    ctxSource: ctx ? ctx.source : null,
    blocked: blockReason,
    lint: lintNote || null,
  });

  // In GUI clients the advise line below reaches the model's context, not the
  // user's eyes — persist the readout so the widget can show a "last
  // pre-flight" row. Written in every mode; it's telemetry, not advice.
  try {
    writeJson(statePaths().preflight, {
      ts: new Date().toISOString(),
      session: input.session_id || null,
      est: { low: est.low, high: est.high, content: est.content },
      heavy,
      projected,
      ctxSource: ctx ? ctx.source : null,
      blocked: blockReason,
      lint: lintNote || null,
    });
  } catch {
    /* display is best-effort; never block the hook */
  }

  if (cfg.mode === 'observe') return 0;

  if (blockReason) {
    process.stderr.write(
      `[cctower] blocked: ${blockReason}. Resend with \`${FORCE}\` in the prompt to override.\n`,
    );
    return 2;
  }

  // advise (and gate when it doesn't block): print only when noteworthy.
  const noteworthy =
    !!lintNote ||
    heavy ||
    est.high >= NOISE_FLOOR ||
    (projected != null && projected >= cfg.contextWarnPct);
  if (noteworthy) process.stdout.write(adviseLine({ est, projected, snapshot, lintNote }) + '\n');

  return 0;
}

try {
  process.exit(run());
} catch {
  process.exit(0); // fail open
}

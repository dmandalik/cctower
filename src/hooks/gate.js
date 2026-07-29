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
const { lintAll, insightLine, isHeavy } = require('../lint');
const T = require('../transcript');

// Repo context for prompt-specific lint suggestions: recently-changed files
// (anchor candidates) and the tracked file list (stale-reference matching).
// Each git call is time-boxed and fail-open; small repos answer in ~10ms.
function repoContext(cwd) {
  const dir = cwd || process.cwd();
  const git = (args) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 300,
        maxBuffer: 2 * 1024 * 1024,
      })
        .toString()
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const recent = [
    ...new Set([
      ...git(['status', '--porcelain']).map((l) => l.slice(3).trim()),
      ...git(['diff', '--name-only', 'HEAD~5', 'HEAD']),
    ]),
  ].slice(0, 20);
  return { recent, all: git(['ls-files']).slice(0, 5000) };
}

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
const WINDOW_DEFAULT = 200_000;
const WINDOW_EXTENDED = 1_000_000;

// Context window size for the model in play. Extended-context models
// (verified live: fable-5 runs 1M) get the big window; and if measured usage
// EXCEEDS the assumed size, the assumption is provably wrong — bump to 1M
// rather than report a fictitious 100%. Self-correcting over hardcoded.
function windowSize(modelId, usageTokens, snapshotSize) {
  let size = snapshotSize || WINDOW_DEFAULT;
  if (/\[1m\]|fable|mythos/i.test(String(modelId || ''))) size = Math.max(size, WINDOW_EXTENDED);
  if (usageTokens != null && usageTokens > size) size = WINDOW_EXTENDED;
  return size;
}

function liveContext(tailEntries, snapshot) {
  const fresh =
    snapshot && snapshot.ts && Date.now() - Date.parse(snapshot.ts) < SNAP_FRESH_MS;
  if (fresh && typeof snapshot.contextPct === 'number') {
    return { pct: snapshot.contextPct, size: (snapshot && snapshot.contextSize) || WINDOW_DEFAULT, source: 'statusline' };
  }
  const tokens = T.lastContextTokens(tailEntries);
  if (tokens != null) {
    const size = windowSize(T.lastAssistantModel(tailEntries), tokens, null);
    return {
      pct: Math.min(100, Math.round((tokens / size) * 100)),
      size,
      tokens,
      source: size === WINDOW_EXTENDED ? 'transcript · 1M window' : 'transcript',
    };
  }
  if (snapshot && typeof snapshot.contextPct === 'number') {
    return { pct: snapshot.contextPct, size: snapshot.contextSize || WINDOW_DEFAULT, source: 'stale statusline' };
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

  // Read the prior session record early — lint wants last turn's verdict.
  let proj = input.cwd ? path.basename(String(input.cwd)) : undefined;
  let prevSess = {};
  if (input.session_id) {
    prevSess = readJson(path.join(statePaths().sessions, `${input.session_id}.json`), {}) || {};
    proj = proj || prevSess.project;
  }

  // Prompt-specific insights: quoted evidence + concrete fixes, using the
  // chat (transcript) and repo (git) as context. Top insight drives the
  // toast/advise line; the widget shows up to three.
  const insights = cfg.lint
    ? lintAll({
        prompt,
        estHigh: est.high,
        heavy,
        model,
        transcriptText: readTranscript(input.transcript_path),
        prevPrompts: tailEntries.filter(T.isHumanPrompt).map(T.userText),
        repo: repoContext(input.cwd),
        readFile: (f) => {
          try {
            const p = path.isAbsolute(f) ? f : path.join(input.cwd || '.', f);
            return fs.statSync(p).size < 262144 ? fs.readFileSync(p, 'utf8') : null;
          } catch {
            return null;
          }
        },
        fileExists: (f) => {
          try {
            return fs.existsSync(path.isAbsolute(f) ? f : path.join(input.cwd || '.', f));
          } catch {
            return false;
          }
        },
        lastVerdict: prevSess.verdict || null,
        config: cfg,
      })
    : [];
  const lintNote = insights.length ? insightLine(insights[0]) : null;

  // Record this turn for the landing report (git ref + estimate).
  if (input.session_id) {
    const file = path.join(statePaths().sessions, `${input.session_id}.json`);
    const prev = prevSess;
    writeJson(file, {
      ...prev,
      project: proj,
      title: chatTitle || prev.title, // the app's own chat name, when present
      state: 'working', // prompt submitted -> Claude is working
      stall: false,
      transcriptPath: input.transcript_path || prev.transcriptPath,
      lastPrompt: { ts: new Date().toISOString(), estimate: est, gitRef: gitRef(input.cwd) },
      // A !force in gate mode opens the grace window and feeds the
      // "you've overridden N times" escalation hint.
      ...(forced && cfg.mode === 'gate'
        ? { lastForcedAt: Date.now(), forcedCount: (prev.forcedCount || 0) + 1 }
        : {}),
    });

    // Notify on the transition INTO working (not on the first prompt of a
    // brand-new session, and not on repeat working states).
    const muted = Array.isArray(cfg.mutedProjects) && cfg.mutedProjects.includes(proj);
    if (cfg.notifications.working && !muted && prev.state && prev.state !== 'working') {
      notify({ title: `▶ Claude working · ${proj}`, message: 'Started a turn', sound: cfg.notifications.sound, group: input.session_id });
    }
  }

  // Decide the gate outcome up front so the event log and the widget's
  // pre-flight row can both show WHY a prompt was blocked — with the CAUSE
  // (whose fault: the chat's history, this prompt, or quota) and the remedy.
  const graceMin = Number.isFinite(cfg.gateGraceMinutes) ? cfg.gateGraceMinutes : 15;
  const inGrace =
    typeof prevSess.lastForcedAt === 'number' && Date.now() - prevSess.lastForcedAt < graceMin * 60_000;
  let blockReason = null;
  let blockCause = null;
  let remedy = null;
  if (cfg.mode === 'gate' && !forced && !inGrace) {
    const quotaPct = snapshot && snapshot.quota && snapshot.quota.fiveHourPct;
    if (projected != null && projected >= cfg.contextWarnPct) {
      if (ctx && ctx.pct >= cfg.contextWarnPct) {
        blockCause = 'context-full';
        blockReason = `this chat's history already fills ${ctx.pct}% of its ${humanTokens(ctx.size)} window (threshold ${cfg.contextWarnPct}%) — your prompt isn't the problem`;
        remedy = 'run /compact to shrink history, or start a fresh chat';
      } else {
        blockCause = 'prompt-too-big';
        blockReason = `your ~${humanTokens(est.high)}-token prompt pushes context from ${ctx ? ctx.pct : '?'}% to ${projected}% (threshold ${cfg.contextWarnPct}%)`;
        remedy = 'trim the prompt — reference files by path instead of pasting them';
      }
    } else if (typeof quotaPct === 'number' && quotaPct >= cfg.quotaWarnPct) {
      blockCause = 'quota';
      blockReason = `5h quota ${quotaPct}% ≥ ${cfg.quotaWarnPct}%`;
      remedy = 'wait for the quota reset, or switch to a lighter model with /model';
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
        message: `${remedy} — or resend with !force to override`,
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
    // Stable rule note (not the per-prompt evidence line) so the report's
    // "top lint findings" aggregation still groups correctly.
    lint: insights.length ? insights[0].note : null,
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
      blockCause,
      remedy,
      lint: lintNote || null,
      insights: insights.slice(0, 3),
    });
  } catch {
    /* display is best-effort; never block the hook */
  }

  if (cfg.mode === 'observe') return 0;

  if (blockReason) {
    const lines = [
      `[cctower] ⛔ blocked: ${blockReason}.`,
      `[cctower] fix: ${remedy}.`,
      `[cctower] send anyway: add ${FORCE} to the prompt${graceMin > 0 ? ` (gate then pauses ${graceMin} min for this chat)` : ''} · Context warn is ${cfg.contextWarnPct}% in the widget.`,
    ];
    if ((prevSess.forcedCount || 0) >= 3) {
      lines.push(
        `[cctower] you've overridden ${prevSess.forcedCount} times this session — consider raising Context warn or switching to advise mode.`,
      );
    }
    if (lintNote) lines.push(`[cctower] note (advisory only, not the block reason): ${lintNote}.`);
    process.stderr.write(lines.join('\n') + '\n');
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

'use strict';

// `cctower report`: a 7-day plain-text summary aggregated from the event log
// plus current calibration/snapshot. Read-only; tolerant of a sparse state dir.

const fs = require('fs');
const path = require('path');
const { statePaths } = require('./paths');
const { readJson } = require('./state');
const { accuracy } = require('./calibrate');
const { getQuota } = require('./quota');
const { humanTokens } = require('./estimator');

const DAY_MS = 86_400_000;
const VERDICTS = ['VERIFIED', 'UNVERIFIED', 'FAILED', 'NO-OP'];

function readEvents(file, cutoff) {
  try {
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const t = Date.parse(e.ts);
      if (Number.isFinite(t) && t >= cutoff) out.push(e);
    }
    return out;
  } catch {
    return [];
  }
}

function collect({ days = 7, now = Date.now() } = {}) {
  const p = statePaths();
  const cutoff = now - days * DAY_MS;
  const events = readEvents(p.events, cutoff);

  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const lintCounts = {};
  let gatePrompts = 0;
  let landTurns = 0;
  let notifications = 0;

  for (const e of events) {
    if (e.event === 'gate') {
      gatePrompts++;
      if (e.lint) lintCounts[e.lint] = (lintCounts[e.lint] || 0) + 1;
    } else if (e.event === 'land') {
      landTurns++;
      if (verdicts[e.verdict] != null) verdicts[e.verdict]++;
    } else if (e.event === 'notification') {
      notifications++;
    }
  }

  // Idle time: sum waited seconds from sessions touched within the window.
  let idleSeconds = 0;
  try {
    for (const f of fs.readdirSync(p.sessions)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(p.sessions, f);
      if (fs.statSync(fp).mtimeMs < cutoff) continue;
      idleSeconds += (readJson(fp, {}) || {}).waitedSeconds || 0;
    }
  } catch {
    /* no sessions yet */
  }

  const snapshot = readJson(p.snapshot);
  const cal = readJson(p.calibration) || {};

  return {
    days,
    quota: getQuota({ now }),
    estimator: {
      accuracy: accuracy(cal),
      correction: typeof cal.correction === 'number' ? cal.correction : 1,
      samples: (cal.pairs && cal.pairs.length) || 0,
    },
    idleMinutes: Math.round(idleSeconds / 60),
    verdicts,
    landTurns,
    gatePrompts,
    notifications,
    lint: Object.entries(lintCounts)
      .map(([note, count]) => ({ note, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

function render(r) {
  const L = [];
  L.push(`cctower — last ${r.days} days`, '');

  if (!r.gatePrompts && !r.landTurns && !r.idleMinutes) {
    L.push('  no activity recorded yet — run some Claude sessions with cctower installed.');
    return L.join('\n');
  }

  const v = r.verdicts;
  const vsum = `VERIFIED ${v.VERIFIED} · UNVERIFIED ${v.UNVERIFIED} · FAILED ${v.FAILED} · NO-OP ${v['NO-OP']}`;
  L.push(`  prompts gated    ${r.gatePrompts}`);
  L.push(`  turns landed     ${r.landTurns}   (${vsum})`);
  L.push(`  idle waiting     ${r.idleMinutes} min`);

  const acc = r.estimator.accuracy == null ? 'no data' : `±${r.estimator.accuracy}% median error`;
  L.push(`  estimator        ${acc} · correction x${r.estimator.correction.toFixed(2)} (${r.estimator.samples} samples)`);

  if (r.quota && r.quota.source === 'official') {
    const parts = [];
    if (typeof r.quota.fiveHourPct === 'number') parts.push(`5h ${r.quota.fiveHourPct}%`);
    if (typeof r.quota.weeklyPct === 'number') parts.push(`wk ${r.quota.weeklyPct}%`);
    if (parts.length) L.push(`  quota now        ${parts.join(' · ')}  (official)`);
  } else if (r.quota && r.quota.source === 'local estimate') {
    L.push(`  quota now        5h ${humanTokens(r.quota.fiveHourTokens)} · wk ${humanTokens(r.quota.weeklyTokens)} tokens  (local estimate)`);
  } else {
    L.push('  quota now        no data (no statusline rate limits, no local transcripts)');
  }

  if (r.lint.length) {
    L.push('  top lint findings');
    for (const { note, count } of r.lint) L.push(`    - ${note}  (${count})`);
  }
  return L.join('\n');
}

module.exports = { collect, render };

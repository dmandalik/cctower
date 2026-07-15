#!/usr/bin/env node
'use strict';

// Statusline command. Two jobs:
//   1. print a compact meter, e.g. "⌁ ctx 42% · 5h 61% · wk 34% · est ±4%"
//   2. persist the parsed telemetry to snapshot.json — the only bridge between
//      Claude Code's live session data and the hooks (which have no API).
// Every field is feature-detected: schemas evolve, so a missing field degrades
// the output rather than crashing. Fail open — the statusline must never break.

const { readStdinJson } = require('./io');
const { statePaths } = require('./paths');
const { readJson, writeJson } = require('./state');

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Best-effort percentage out of an unknown rate-limit shape.
function pct(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['used_percentage', 'utilization', 'percent', 'used_pct']) {
    if (num(obj[k]) != null) return Math.round(obj[k]);
  }
  return null;
}

// Median absolute % error over the last 50 calibration pairs, if any.
function accuracy() {
  const cal = readJson(statePaths().calibration);
  const pairs = cal && Array.isArray(cal.pairs) ? cal.pairs.slice(-50) : [];
  const errs = pairs
    .filter((p) => num(p.estimate) && num(p.actual) && p.estimate > 0)
    .map((p) => Math.abs(p.actual - p.estimate) / p.estimate);
  if (!errs.length) return null;
  errs.sort((a, b) => a - b);
  const mid = Math.floor(errs.length / 2);
  const med = errs.length % 2 ? errs[mid] : (errs[mid - 1] + errs[mid]) / 2;
  return Math.round(med * 100);
}

function buildSnapshot(input) {
  const model = input.model || {};
  const ctx = input.context_window || {};
  const rl = input.rate_limits || {};

  const snap = {
    ts: new Date().toISOString(),
    session: input.session_id || null,
    model: model.id || null,
    modelName: model.display_name || null,
    contextPct: num(ctx.used_percentage) != null ? Math.round(ctx.used_percentage) : null,
    contextSize: num(ctx.context_window_size),
  };

  const fiveHourPct = pct(rl.five_hour);
  const weeklyPct = pct(rl.seven_day || rl.weekly);
  if (fiveHourPct != null || weeklyPct != null) {
    snap.quota = {};
    if (fiveHourPct != null) snap.quota.fiveHourPct = fiveHourPct;
    if (weeklyPct != null) snap.quota.weeklyPct = weeklyPct;
    const resets = rl.five_hour && (rl.five_hour.resets_at || rl.five_hour.reset_at);
    if (resets) snap.quota.fiveHourResets = String(resets);
  }
  return snap;
}

function meter(snap) {
  const parts = [];
  if (snap.contextPct != null) parts.push(`ctx ${snap.contextPct}%`);
  if (snap.quota && snap.quota.fiveHourPct != null) parts.push(`5h ${snap.quota.fiveHourPct}%`);
  if (snap.quota && snap.quota.weeklyPct != null) parts.push(`wk ${snap.quota.weeklyPct}%`);
  const acc = accuracy();
  if (acc != null) parts.push(`est ±${acc}%`);
  if (!parts.length) return `⌁ ${snap.modelName || 'cctower'}`;
  return `⌁ ${parts.join(' · ')}`;
}

try {
  const input = readStdinJson();
  const snap = buildSnapshot(input);
  try {
    writeJson(statePaths().snapshot, snap);
  } catch {
    /* persistence is best-effort; still print the meter */
  }
  process.stdout.write(meter(snap) + '\n');
} catch {
  process.exit(0); // fail open — never break the UI
}

'use strict';

// Quota with an honest source tag.
//   "official"       — rate_limits captured by the statusline into
//                      snapshot.json (field is version-dependent; feature-
//                      detected).
//   "local estimate" — input+output+cache tokens aggregated from Claude
//                      Code's own transcripts (~/.claude/projects/**/*.jsonl)
//                      over rolling 5-hour / 7-day windows. No percentages:
//                      plan limits aren't knowable locally, so we report
//                      token volume, clearly tagged.
// The aggregation is cached in the state dir — refreshed at most once per
// minute, per-file incremental by mtime — so no caller pays a full rescan.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { statePaths } = require('./paths');
const { readJson, writeJson } = require('./state');

const FIVE_H_MS = 5 * 3600 * 1000;
const WEEK_MS = 7 * 86400 * 1000;
const BUCKET_MS = 10 * 60 * 1000; // 10-minute buckets: ≤10min window error
const REFRESH_MS = 60 * 1000;

function projectsDir() {
  return process.env.CCTOWER_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
}

function cacheFile() {
  return path.join(statePaths().home, 'quota-cache.json');
}

function listTranscripts(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

// Parse one transcript into token buckets: { "<bucket start ms>": tokens }.
function bucketFile(file, cutoff) {
  const buckets = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return buckets;
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"usage"')) continue; // cheap pre-filter
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const u = e && e.message && e.message.usage;
    if (!u) continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const tokens =
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0);
    if (!tokens) continue;
    const b = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    buckets[b] = (buckets[b] || 0) + tokens;
  }
  return buckets;
}

function sumWindow(files, from, to) {
  let sum = 0;
  for (const f of Object.values(files)) {
    for (const [start, tokens] of Object.entries(f.buckets)) {
      const s = Number(start);
      if (s + BUCKET_MS > from && s < to) sum += tokens;
    }
  }
  return sum;
}

// Returns { fiveHourTokens, weeklyTokens } or null when no transcripts exist.
function localEstimate(now = Date.now()) {
  const cutoff = now - WEEK_MS;
  const cache = readJson(cacheFile(), {}) || {};

  let files = cache.files || {};
  const fresh = typeof cache.updatedAt === 'number' && now - cache.updatedAt < REFRESH_MS;

  if (!fresh) {
    const found = listTranscripts(projectsDir());
    if (!found.length) return null;
    const next = {};
    for (const p of found) {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(p).mtimeMs;
      } catch {
        continue;
      }
      const prev = files[p];
      next[p] = prev && prev.mtimeMs === mtimeMs ? prev : { mtimeMs, buckets: bucketFile(p, cutoff) };
      // prune buckets that fell out of the 7-day window
      for (const start of Object.keys(next[p].buckets)) {
        if (Number(start) + BUCKET_MS <= cutoff) delete next[p].buckets[start];
      }
    }
    files = next;
    try {
      writeJson(cacheFile(), { updatedAt: now, files });
    } catch {
      /* cache is best-effort */
    }
  } else if (!Object.keys(files).length) {
    return null;
  }

  return {
    fiveHourTokens: sumWindow(files, now - FIVE_H_MS, now),
    weeklyTokens: sumWindow(files, cutoff, now),
  };
}

// The one quota entry point: official when the statusline captured
// rate_limits, else local estimate, else null (both sources failed).
function getQuota({ now = Date.now() } = {}) {
  const snap = readJson(statePaths().snapshot);
  const q = snap && snap.quota;
  if (q && (typeof q.fiveHourPct === 'number' || typeof q.weeklyPct === 'number')) {
    return { source: 'official', ...q };
  }
  const est = localEstimate(now);
  if (est) return { source: 'local estimate', ...est };
  return null;
}

module.exports = { getQuota, localEstimate, projectsDir };

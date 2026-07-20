'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Every test points CCTOWER_HOME and CCTOWER_CLAUDE_PROJECTS at throwaway
// dirs — the real ~/.claude is never read.
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-quota-home-'));
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-quota-proj-'));
  process.env.CCTOWER_HOME = home;
  process.env.CCTOWER_CLAUDE_PROJECTS = projects;
  return { home, projects };
}

function usageLine(tsMs, tokens) {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(tsMs).toISOString(),
      message: { role: 'assistant', usage: { input_tokens: tokens, output_tokens: 0 } },
    }) + '\n'
  );
}

function seedTranscript(projects, name, lines) {
  const dir = path.join(projects, 'proj-a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.join(''));
}

const { getQuota, localEstimate } = require('../src/quota');

test('local estimate sums the 5h and 7d windows from synthetic transcripts', () => {
  const { projects } = sandbox();
  const now = Date.now();
  seedTranscript(projects, 's1.jsonl', [
    usageLine(now - 3600e3, 1000), // 1h ago -> both windows
    usageLine(now - 6 * 3600e3, 500), // 6h ago -> weekly only
    usageLine(now - 8 * 86400e3, 200), // 8d ago -> excluded
  ]);
  const q = getQuota({ now });
  assert.strictEqual(q.source, 'local estimate');
  assert.strictEqual(q.fiveHourTokens, 1000);
  assert.strictEqual(q.weeklyTokens, 1500);
});

test('official rate_limits from the snapshot win over the local estimate', () => {
  const { home, projects } = sandbox();
  seedTranscript(projects, 's1.jsonl', [usageLine(Date.now(), 99)]);
  fs.writeFileSync(
    path.join(home, 'snapshot.json'),
    JSON.stringify({ quota: { fiveHourPct: 38, weeklyPct: 22 } }),
  );
  const q = getQuota();
  assert.strictEqual(q.source, 'official');
  assert.strictEqual(q.fiveHourPct, 38);
});

test('no snapshot quota and no transcripts -> null (both sources failed)', () => {
  sandbox();
  assert.strictEqual(getQuota(), null);
});

test('cache: fresh results are reused, stale cache rescans changed files', () => {
  const { home, projects } = sandbox();
  const now = Date.now();
  const file = 's1.jsonl';
  seedTranscript(projects, file, [usageLine(now - 3600e3, 1000)]);

  assert.strictEqual(localEstimate(now).fiveHourTokens, 1000);

  // Append more usage; within the 60s refresh window the cache short-circuits.
  fs.appendFileSync(path.join(projects, 'proj-a', file), usageLine(now - 1800e3, 500));
  assert.strictEqual(localEstimate(now + 1000).fiveHourTokens, 1000, 'fresh cache reused');

  // Expire the cache; the changed mtime forces a reparse of that file.
  const cachePath = path.join(home, 'quota-cache.json');
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  cache.updatedAt = now - 120e3;
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  assert.strictEqual(localEstimate(now + 2000).fiveHourTokens, 1500, 'stale cache rescanned');
});

test('report renders the local-estimate tag', () => {
  const { home } = sandbox();
  // one event so the report doesn't short-circuit to "no activity"
  fs.writeFileSync(
    path.join(home, 'events.ndjson'),
    JSON.stringify({ ts: new Date().toISOString(), event: 'gate' }) + '\n',
  );
  seedTranscript(process.env.CCTOWER_CLAUDE_PROJECTS, 's1.jsonl', [usageLine(Date.now(), 2500)]);
  const report = require('../src/report');
  const out = report.render(report.collect());
  assert.match(out, /quota now\s+5h 2\.5k · wk 2\.5k tokens\s+\(local estimate\)/);
});

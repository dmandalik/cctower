'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'cctower.js');

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-report-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 86400000).toISOString(); // outside 7d window
  const events = [
    { ts: now, event: 'gate', lint: 'heavy task with no success criteria' },
    { ts: now, event: 'gate', lint: 'heavy task with no success criteria' },
    { ts: now, event: 'gate', lint: 'premium model for a small prompt' },
    { ts: now, event: 'gate' },
    { ts: now, event: 'land', verdict: 'VERIFIED' },
    { ts: now, event: 'land', verdict: 'FAILED' },
    { ts: now, event: 'notification', kind: 'permission' },
    { ts: old, event: 'land', verdict: 'VERIFIED' }, // too old, excluded
  ];
  fs.writeFileSync(path.join(dir, 'events.ndjson'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'sessions', 's1.json'), JSON.stringify({ waitedSeconds: 300 }));
  fs.writeFileSync(path.join(dir, 'sessions', 's2.json'), JSON.stringify({ waitedSeconds: 120 }));
  fs.writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify({ pairs: [{ estimate: 100, actual: 110 }], correction: 1.1 }));
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ quota: { fiveHourPct: 78, weeklyPct: 41 } }));
  return dir;
}

function collect(dir) {
  const src = path.join(__dirname, '..', 'src', 'report');
  process.env.CCTOWER_HOME = dir;
  delete require.cache[require.resolve(src)];
  return require(src).collect();
}

test('collect aggregates verdicts, lint, idle within the 7-day window', () => {
  const r = collect(seed());
  assert.strictEqual(r.gatePrompts, 4);
  assert.strictEqual(r.landTurns, 2); // the 30-day-old land is excluded
  assert.strictEqual(r.verdicts.VERIFIED, 1);
  assert.strictEqual(r.verdicts.FAILED, 1);
  assert.strictEqual(r.idleMinutes, 7); // (300 + 120) / 60
  assert.deepStrictEqual(r.lint[0], { note: 'heavy task with no success criteria', count: 2 });
  assert.strictEqual(r.estimator.accuracy, 10);
});

test('report CLI renders a readable summary', () => {
  const dir = seed();
  const res = spawnSync('node', [BIN, 'report'], {
    env: { ...process.env, CCTOWER_HOME: dir },
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /last 7 days/);
  assert.match(res.stdout, /turns landed\s+2/);
  assert.match(res.stdout, /VERIFIED 1 · UNVERIFIED 0 · FAILED 1/);
  assert.match(res.stdout, /idle waiting\s+7 min/);
  assert.match(res.stdout, /top lint findings/);
});

test('report on an empty state dir says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-report-empty-'));
  const emptyProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-report-proj-'));
  const res = spawnSync('node', [BIN, 'report'], {
    env: { ...process.env, CCTOWER_HOME: dir, CCTOWER_CLAUDE_PROJECTS: emptyProjects },
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /no activity recorded yet/);
});

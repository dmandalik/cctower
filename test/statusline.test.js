'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SL = path.join(__dirname, '..', 'src', 'statusline.js');
const FIX = path.join(__dirname, 'fixtures');

function run(inputObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-sl-'));
  const res = spawnSync('node', [SL], {
    input: JSON.stringify(inputObj),
    env: { ...process.env, CCTOWER_HOME: dir },
    encoding: 'utf8',
  });
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
  return { res, snap };
}

test('prints a ctx meter and persists the snapshot', () => {
  const input = JSON.parse(fs.readFileSync(path.join(FIX, 'statusline.json'), 'utf8'));
  const { res, snap } = run(input);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /⌁ ctx 42%/);
  assert.strictEqual(snap.contextPct, 42);
  assert.strictEqual(snap.model, 'claude-opus-4-8');
  assert.strictEqual(snap.contextSize, 200000);
  assert.ok(!snap.quota, 'no rate_limits in input -> no quota persisted');
});

test('feature-detects rate_limits when present', () => {
  const input = {
    model: { id: 'claude-opus-4-8', display_name: 'Opus' },
    context_window: { used_percentage: 55, context_window_size: 200000 },
    rate_limits: {
      five_hour: { used_percentage: 61, resets_at: '3:40pm' },
      seven_day: { used_percentage: 34 },
    },
  };
  const { res, snap } = run(input);
  assert.match(res.stdout, /5h 61%/);
  assert.match(res.stdout, /wk 34%/);
  assert.strictEqual(snap.quota.fiveHourPct, 61);
  assert.strictEqual(snap.quota.weeklyPct, 34);
  assert.strictEqual(snap.quota.fiveHourResets, '3:40pm');
});

test('degrades gracefully on an empty payload', () => {
  const { res, snap } = run({});
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /⌁/);
  assert.strictEqual(snap.contextPct, null);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate every test in its own CCTOWER_HOME before requiring the modules that
// read it. paths.home() resolves the env at call time, so setting it per test
// is enough — nothing touches the real ~/.
function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-state-'));
  process.env.CCTOWER_HOME = dir;
  return dir;
}

const state = require('../src/state');
const { statePaths } = require('../src/paths');

test('ensureDirs creates the state layout under CCTOWER_HOME', () => {
  freshHome();
  const p = state.ensureDirs();
  for (const dir of [p.home, p.sessions, p.cards, p.backups]) {
    assert.ok(fs.existsSync(dir), `${dir} should exist`);
  }
});

test('writeJson is atomic and leaves no temp file behind', () => {
  const home = freshHome();
  const p = statePaths();
  state.writeJson(p.snapshot, { model: 'opus', contextPct: 42 });
  assert.deepStrictEqual(state.readJson(p.snapshot), { model: 'opus', contextPct: 42 });
  const leftovers = fs.readdirSync(home).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

test('readJson returns the fallback for missing or invalid files', () => {
  freshHome();
  assert.strictEqual(state.readJson('/no/such/file.json', null), null);
  assert.deepStrictEqual(state.readJson('/no/such/file.json', {}), {});
});

test('ensureConfig writes defaults once, then preserves edits', () => {
  freshHome();
  const cfg = state.ensureConfig();
  assert.strictEqual(cfg.mode, 'advise');
  assert.strictEqual(cfg.contextWarnPct, 70);

  const p = statePaths();
  state.writeJson(p.config, { ...state.DEFAULT_CONFIG, mode: 'gate' });
  const again = state.ensureConfig();
  assert.strictEqual(again.mode, 'gate', 'existing config must not be overwritten');
});

test('loadConfig merges partial config over defaults', () => {
  freshHome();
  const p = statePaths();
  fs.mkdirSync(p.home, { recursive: true });
  state.writeJson(p.config, { mode: 'observe' });
  const cfg = state.loadConfig();
  assert.strictEqual(cfg.mode, 'observe');
  assert.strictEqual(cfg.quotaWarnPct, 85, 'unspecified keys fall back to defaults');
});

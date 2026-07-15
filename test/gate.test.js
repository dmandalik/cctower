'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE = path.join(__dirname, '..', 'src', 'hooks', 'gate.js');
const FIX = path.join(__dirname, 'fixtures');

function readFix(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

// Isolated state dir, optionally seeded with a config mode + snapshot.
function home({ mode, snapshot } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-gate-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  if (mode) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode }));
  if (snapshot)
    fs.writeFileSync(path.join(dir, 'snapshot.json'), fs.readFileSync(path.join(FIX, snapshot)));
  return dir;
}

function runGate(inputObj, cctowerHome) {
  return spawnSync('node', [GATE], {
    input: JSON.stringify(inputObj),
    env: { ...process.env, CCTOWER_HOME: cctowerHome },
    encoding: 'utf8',
  });
}

test('advise mode with no snapshot prints a token line and exits 0', () => {
  const dir = home();
  const res = runGate(readFix('prompt-basic.json'), dir);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /\[cctower\]/);
  assert.match(res.stdout, /tokens/);
});

test('advise records the turn (git ref + estimate) in the session file', () => {
  const dir = home();
  runGate(readFix('prompt-basic.json'), dir);
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-basic-0001.json'), 'utf8'));
  assert.ok(sess.lastPrompt);
  assert.ok(sess.lastPrompt.estimate.high > 0);
  assert.ok('gitRef' in sess.lastPrompt);
});

test('gate mode blocks (exit 2) when quota/context cross thresholds', () => {
  const dir = home({ mode: 'gate', snapshot: 'snapshot-high.json' });
  const res = runGate(readFix('prompt-heavy.json'), dir);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /blocked/);
  assert.match(res.stderr, /!force/);
});

test('!force overrides the gate (exit 0)', () => {
  const dir = home({ mode: 'gate', snapshot: 'snapshot-high.json' });
  const input = readFix('prompt-heavy.json');
  input.prompt += ' !force';
  const res = runGate(input, dir);
  assert.strictEqual(res.status, 0);
});

test('gate mode passes a light prompt when thresholds are fine', () => {
  const dir = home({ mode: 'gate' }); // no snapshot -> no projection -> no block
  const res = runGate(readFix('prompt-basic.json'), dir);
  assert.strictEqual(res.status, 0);
});

test('observe mode is silent but logs an event', () => {
  const dir = home({ mode: 'observe' });
  const res = runGate(readFix('prompt-basic.json'), dir);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), '');
  const events = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').trim().split('\n');
  assert.ok(JSON.parse(events[0]).event === 'gate');
});

test('malformed stdin fails open (exit 0, no output)', () => {
  const dir = home();
  const res = spawnSync('node', [GATE], {
    input: 'not json at all',
    env: { ...process.env, CCTOWER_HOME: dir },
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0);
});

test('advise line for the heavy prompt carries context and a lint note', () => {
  const dir = home({ mode: 'advise', snapshot: 'snapshot-high.json' });
  const res = runGate(readFix('prompt-heavy.json'), dir);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /context → \d+%/);
  assert.match(res.stdout, /5h quota 90%/);
  assert.match(res.stdout, /success criteria/); // lint rule 1
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ATTN = path.join(__dirname, '..', 'src', 'hooks', 'attention.js');
const FIX = path.join(__dirname, 'fixtures');

function readFix(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

// Isolated state dir + a notify log so tests never fire real toasts.
function ctx(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-attn-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return { home: dir, log: path.join(dir, 'notify.ndjson') };
}

function run(inputObj, { home, log }) {
  const res = spawnSync('node', [ATTN], {
    input: JSON.stringify({ ...inputObj, cwd: '/Users/me/projects/algo-pipeline' }),
    env: { ...process.env, CCTOWER_HOME: home, CCTOWER_NOTIFY_LOG: log },
    encoding: 'utf8',
  });
  const notes = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  return { res, notes };
}

function session(home, id) {
  return JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${id}.json`), 'utf8'));
}

test('permission Notification toasts as urgent and records waitingSince', () => {
  const c = ctx();
  const { res, notes } = run(readFix('notification-permission.json'), c);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].urgent, true);
  assert.match(notes[0].title, /permission/i);
  assert.match(notes[0].title, /algo-pipeline/); // toast names the project
  assert.ok(typeof session(c.home, 'sess-attn-0001').waitingSince === 'number');
});

test('idle Notification toasts as non-urgent', () => {
  const c = ctx();
  const { notes } = run(readFix('notification-idle.json'), c);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].urgent, false);
  assert.match(notes[0].title, /waiting/i);
});

test('Stop toasts "done", clears waitingSince, and accumulates waited seconds', () => {
  const c = ctx();
  // Pre-seed a wait that started 5s ago.
  fs.writeFileSync(
    path.join(c.home, 'sessions', 'sess-attn-0001.json'),
    JSON.stringify({ waitingSince: Date.now() - 5000 }),
  );
  const { notes } = run(readFix('stop.json'), c);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].title, /done/i);
  const s = session(c.home, 'sess-attn-0001');
  assert.ok(!('waitingSince' in s), 'waitingSince cleared');
  assert.ok(s.waitedSeconds >= 4, `waitedSeconds ~5, got ${s.waitedSeconds}`);
});

test('done notification carries the verdict when land.js has set one', () => {
  const c = ctx();
  fs.writeFileSync(
    path.join(c.home, 'sessions', 'sess-attn-0001.json'),
    JSON.stringify({ verdict: 'VERIFIED' }),
  );
  const { notes } = run(readFix('stop.json'), c);
  assert.match(notes[0].title, /VERIFIED/);
});

test('dedupe: a second notification within 30s is suppressed', () => {
  const c = ctx();
  run(readFix('notification-permission.json'), c); // first fires
  const { notes } = run(readFix('notification-permission.json'), c); // second suppressed
  assert.strictEqual(notes.length, 1, 'only one toast within the 30s window');
});

test('config toggle off silences the done notification but still accounts time', () => {
  const c = ctx({ notifications: { done: false, needsInput: true, sound: false } });
  fs.writeFileSync(
    path.join(c.home, 'sessions', 'sess-attn-0001.json'),
    JSON.stringify({ waitingSince: Date.now() - 3000 }),
  );
  const { notes } = run(readFix('stop.json'), c);
  assert.strictEqual(notes.length, 0, 'no toast when done=false');
  assert.ok(session(c.home, 'sess-attn-0001').waitedSeconds >= 2, 'time still accounted');
});

test('a muted project suppresses the toast', () => {
  const c = ctx({
    notifications: { done: true, needsInput: true, sound: false },
    mutedProjects: ['algo-pipeline'],
  });
  const { notes } = run(readFix('notification-permission.json'), c);
  assert.strictEqual(notes.length, 0, 'no toast for a muted project');
});

test('fails open on malformed stdin', () => {
  const c = ctx();
  const res = spawnSync('node', [ATTN], {
    input: '}{ not json',
    env: { ...process.env, CCTOWER_HOME: c.home, CCTOWER_NOTIFY_LOG: c.log },
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0);
});

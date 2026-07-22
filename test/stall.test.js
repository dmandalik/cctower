'use strict';

// Stall detection (shared by the watcher daemon and the widget server).
// Notifications route to CCTOWER_NOTIFY_LOG; the process table is faked via
// CCTOWER_FAKE_PS so results are deterministic.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-stall-'));
process.env.CCTOWER_HOME = dir;
process.env.CCTOWER_CLAUDE_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-stall-proj-'));
const notifyLog = path.join(dir, 'notify.ndjson');
process.env.CCTOWER_NOTIFY_LOG = notifyLog;
process.env.CCTOWER_FAKE_PS = ''; // default: nothing running
fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });

const { checkSession } = require('../src/stallwatch');

function seedTranscript(name, fixture, ageMs, mutate) {
  const p = path.join(dir, `${name}.jsonl`);
  let body = fs.readFileSync(path.join(FIX, fixture), 'utf8');
  if (mutate) body = mutate(body);
  fs.writeFileSync(p, body);
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(p, old, old);
  return p;
}

function readSession(id) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${id}.json`), 'utf8'));
}

function seedSession(id, sess) {
  fs.writeFileSync(path.join(dir, 'sessions', `${id}.json`), JSON.stringify(sess));
}

function notes() {
  return fs.existsSync(notifyLog)
    ? fs.readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
}

test('pending tool + quiet file + NOT in process table -> waiting + permission toast', () => {
  const t = seedTranscript('perm', 'transcript-pending-tool.jsonl', 60_000);
  seedSession('perm', { project: 'alpha', state: 'working', transcriptPath: t });
  const s = checkSession('perm', readSession('perm'));
  assert.strictEqual(s.state, 'waiting');
  assert.strictEqual(s.stall, true);
  const n = notes().find((x) => /needs permission · alpha/.test(x.title));
  assert.ok(n, 'permission notification fired');
  assert.strictEqual(n.urgent, true);
});

test('pending command RUNNING in the process table -> still working, no toast', () => {
  const t = seedTranscript('run', 'transcript-pending-tool.jsonl', 60_000);
  seedSession('run', { project: 'beta', state: 'working', transcriptPath: t });
  process.env.CCTOWER_FAKE_PS = '/bin/zsh -c rm -rf build\nnode something';
  try {
    const s = checkSession('run', readSession('run'));
    assert.strictEqual(s.state, 'working', 'executing command is not a stall');
    assert.ok(!notes().some((x) => /beta/.test(x.title)));
  } finally {
    process.env.CCTOWER_FAKE_PS = '';
  }
});

test('open AskUserQuestion -> waiting fast, question toast (not urgent)', () => {
  const t = seedTranscript('ask', 'transcript-askuser.jsonl', 5_000);
  seedSession('ask', { project: 'gamma', state: 'working', transcriptPath: t });
  const s = checkSession('ask', readSession('ask'));
  assert.strictEqual(s.state, 'waiting');
  const n = notes().find((x) => /asking you a question · gamma/.test(x.title));
  assert.ok(n);
  assert.strictEqual(n.urgent, false);
});

test('interrupted tool (user pressed Esc) -> NOT waiting', () => {
  const t = seedTranscript('int', 'transcript-interrupted.jsonl', 60_000);
  seedSession('int', { project: 'delta', state: 'working', transcriptPath: t });
  const s = checkSession('int', readSession('int'));
  assert.strictEqual(s.state, 'working', 'interruption proves the user is present');
  assert.ok(!notes().some((x) => /delta/.test(x.title)));
});

test('long-running command stays working even when ps cannot see it', () => {
  const t = seedTranscript('long', 'transcript-pending-tool.jsonl', 60_000, (b) => b.replace('rm -rf build', 'npm test'));
  seedSession('long', { project: 'eps', state: 'working', transcriptPath: t });
  const s = checkSession('long', readSession('long'));
  assert.strictEqual(s.state, 'working');
});

test('fresh writes resume waiting -> working and fold waited seconds', () => {
  const t = seedTranscript('res', 'transcript-pending-tool.jsonl', 60_000);
  seedSession('res', { project: 'zeta', state: 'waiting', stall: true, transcriptPath: t, waitingSince: Date.now() - 8000 });
  fs.utimesSync(t, new Date(), new Date());
  const s = checkSession('res', readSession('res'));
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.stall, false);
  assert.ok(s.waitedSeconds >= 7, `waited folded, got ${s.waitedSeconds}`);
});

test('parse cache is persisted in the session file keyed by transcript mtime', () => {
  const t = seedTranscript('cache', 'transcript-pending-tool.jsonl', 60_000);
  seedSession('cache', { project: 'eta', state: 'working', transcriptPath: t });
  checkSession('cache', readSession('cache'));
  const cached = readSession('cache').stallCheck;
  assert.ok(cached && typeof cached.mtimeMs === 'number', 'stallCheck cached');
});

test('sessions without a transcriptPath are untouched', () => {
  seedSession('bare', { project: 'theta', state: 'working' });
  const s = checkSession('bare', readSession('bare'));
  assert.strictEqual(s.state, 'working');
});

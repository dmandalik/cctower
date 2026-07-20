'use strict';

// The widget server's mid-turn stall watcher: permission dialogs and
// AskUserQuestion fire no hook, so collectState detects them from a stalled
// transcript. Notifications are routed to CCTOWER_NOTIFY_LOG — never the OS.

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
fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });

const { collectState } = require('../src/ui/state');

// Copy a fixture transcript to a session-specific path with a controlled age.
function seedTranscript(name, fixture, ageMs) {
  const p = path.join(dir, `${name}.jsonl`);
  fs.copyFileSync(path.join(FIX, fixture), p);
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(p, old, old);
  return p;
}

function seedSession(id, sess) {
  fs.writeFileSync(path.join(dir, 'sessions', `${id}.json`), JSON.stringify(sess));
}

function readSession(id) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${id}.json`), 'utf8'));
}

function notes() {
  return fs.existsSync(notifyLog)
    ? fs.readFileSync(notifyLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
}

test('quiet pending tool_use flips working -> waiting and notifies (permission)', () => {
  const t = seedTranscript('perm', 'transcript-pending-tool.jsonl', 60_000);
  seedSession('perm', { project: 'alpha', state: 'working', transcriptPath: t });
  const st = collectState();
  const s = st.sessions.find((x) => x.id === 'perm');
  assert.strictEqual(s.status, 'waiting');
  assert.strictEqual(readSession('perm').stall, true);
  const n = notes().find((x) => /needs permission · alpha/.test(x.title));
  assert.ok(n, 'permission notification fired');
  assert.strictEqual(n.urgent, true);
});

test('open AskUserQuestion flips to waiting without the long quiet threshold', () => {
  const t = seedTranscript('ask', 'transcript-askuser.jsonl', 5_000);
  seedSession('ask', { project: 'beta', state: 'working', transcriptPath: t });
  collectState();
  assert.strictEqual(readSession('ask').state, 'waiting');
  assert.ok(notes().some((x) => /asking you a question · beta/.test(x.title)));
});

test('a quiet long-running command is NOT a stall', () => {
  // Same shape as the permission fixture but the pending command is `npm test`.
  const src = fs.readFileSync(path.join(FIX, 'transcript-pending-tool.jsonl'), 'utf8');
  const p = path.join(dir, 'long.jsonl');
  fs.writeFileSync(p, src.replace('rm -rf build', 'npm test'));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(p, old, old);
  seedSession('long', { project: 'gamma', state: 'working', transcriptPath: p });
  collectState();
  assert.strictEqual(readSession('long').state, 'working', 'test run keeps working state');
  assert.ok(!notes().some((x) => /gamma/.test(x.title)), 'no notification for a test run');
});

test('fresh transcript writes resume waiting -> working and fold waited time', () => {
  const t = seedTranscript('resume', 'transcript-pending-tool.jsonl', 60_000);
  seedSession('resume', {
    project: 'delta',
    state: 'waiting',
    stall: true,
    transcriptPath: t,
    waitingSince: Date.now() - 8000,
  });
  fs.utimesSync(t, new Date(), new Date()); // approval just appended
  collectState();
  const s = readSession('resume');
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.stall, false);
  assert.ok(s.waitedSeconds >= 7, `waited time folded, got ${s.waitedSeconds}`);
});

test('sessions without a transcriptPath are untouched', () => {
  seedSession('bare', { project: 'eps', state: 'working' });
  collectState();
  assert.strictEqual(readSession('bare').state, 'working');
});

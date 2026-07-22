'use strict';

// The watcher daemon: polls sessions via stallwatch, exits when idle.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WATCHER = path.join(__dirname, '..', 'src', 'hooks', 'watcher.js');
const FIX = path.join(__dirname, 'fixtures');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function env(dir, extra = {}) {
  return {
    ...process.env,
    CCTOWER_HOME: dir,
    CCTOWER_NOTIFY_LOG: path.join(dir, 'notify.ndjson'),
    CCTOWER_FAKE_PS: '',
    CCTOWER_WATCH_MS: '100',
    ...extra,
  };
}

test('daemon detects a stalled session, notifies, and writes its pidfile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-watchd-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const t = path.join(dir, 'stall.jsonl');
  fs.copyFileSync(path.join(FIX, 'transcript-pending-tool.jsonl'), t);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(t, old, old);
  fs.writeFileSync(
    path.join(dir, 'sessions', 'w1.json'),
    JSON.stringify({ project: 'watched', state: 'working', transcriptPath: t }),
  );

  const child = spawn('node', [WATCHER], { env: env(dir), stdio: 'ignore' });
  try {
    let sess = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'w1.json'), 'utf8'));
      if (sess.state === 'waiting') break;
    }
    assert.strictEqual(sess.state, 'waiting', 'daemon flipped the stalled session');
    const notes = fs.readFileSync(path.join(dir, 'notify.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(notes.some((n) => /needs permission · watched/.test(n.title)));
    assert.strictEqual(Number(fs.readFileSync(path.join(dir, 'watcher.pid'), 'utf8')), child.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

test('daemon exits by itself when idle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-watchd-idle-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true }); // no active sessions
  const child = spawn('node', [WATCHER], { env: env(dir, { CCTOWER_WATCH_IDLE_MS: '250' }), stdio: 'ignore' });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  assert.ok(exited, 'daemon self-terminated after the idle window');
  assert.ok(!fs.existsSync(path.join(dir, 'watcher.pid')), 'pidfile cleaned up');
});

test('a newer daemon displaces an older one via the pidfile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-watchd-race-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  // Keep one active session so neither exits from idleness.
  const t = path.join(dir, 's.jsonl');
  fs.copyFileSync(path.join(FIX, 'transcript-verified.jsonl'), t);
  fs.writeFileSync(path.join(dir, 'sessions', 's.json'), JSON.stringify({ state: 'working', transcriptPath: t }));

  const a = spawn('node', [WATCHER], { env: env(dir), stdio: 'ignore' });
  await sleep(300);
  const b = spawn('node', [WATCHER], { env: env(dir), stdio: 'ignore' });
  try {
    const aExited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      a.on('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.ok(aExited, 'older daemon bowed out to the newer pidfile owner');
  } finally {
    a.kill('SIGKILL');
    b.kill('SIGKILL');
  }
});

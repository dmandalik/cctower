'use strict';

// Stress tests: bursts, concurrency, and a large dashboard. Notifications are
// routed to a log (CCTOWER_NOTIFY_LOG) so the suite never fires real toasts.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { notify } = require('../src/notify');

const ATTN = path.join(__dirname, '..', 'src', 'hooks', 'attention.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cct-stress-'));
}

test('notifier absorbs a burst of 200 without crashing', () => {
  const log = path.join(tmp(), 'n.ndjson');
  process.env.CCTOWER_NOTIFY_LOG = log;
  try {
    for (let i = 0; i < 200; i++) notify({ title: `done ${i}`, message: 'm', sound: true, urgent: i % 2 === 0 });
    assert.strictEqual(fs.readFileSync(log, 'utf8').trim().split('\n').length, 200);
  } finally {
    delete process.env.CCTOWER_NOTIFY_LOG;
  }
});

test('20 concurrent chats each notify once and log cleanly', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const log = path.join(dir, 'n.ndjson');
  const N = 20;

  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      new Promise((resolve) => {
        const p = spawn('node', [ATTN], {
          env: { ...process.env, CCTOWER_HOME: dir, CCTOWER_NOTIFY_LOG: log },
        });
        p.stdin.end(JSON.stringify({ session_id: `s${i}`, hook_event_name: 'Stop', cwd: `/proj/p${i}` }));
        p.on('close', resolve);
      }),
    ),
  );

  const events = fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(events.filter((e) => e.event === 'stop').length, N, 'all stop events logged, no lost appends');
  assert.strictEqual(fs.readdirSync(path.join(dir, 'sessions')).filter((f) => f.endsWith('.json')).length, N);
  assert.strictEqual(fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length, N, 'one toast per chat');
});

test('mixed notification types across concurrent chats', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const log = path.join(dir, 'n.ndjson');
  const inputs = [
    { session_id: 'a', hook_event_name: 'Notification', type: 'permission_prompt', message: 'Allow Bash?', cwd: '/p/a' },
    { session_id: 'b', hook_event_name: 'Notification', type: 'idle_prompt', message: 'waiting', cwd: '/p/b' },
    { session_id: 'c', hook_event_name: 'Stop', cwd: '/p/c' },
  ];
  await Promise.all(inputs.map((input) => new Promise((resolve) => {
    const p = spawn('node', [ATTN], { env: { ...process.env, CCTOWER_HOME: dir, CCTOWER_NOTIFY_LOG: log } });
    p.stdin.end(JSON.stringify(input));
    p.on('close', resolve);
  })));
  const notes = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.strictEqual(notes.length, 3);
  assert.ok(notes.some((n) => n.urgent === true), 'permission is urgent');
  assert.ok(notes.some((n) => /needs permission/i.test(n.title)));
  assert.ok(notes.some((n) => /waiting/i.test(n.title)));
  assert.ok(notes.some((n) => /done/i.test(n.title)));
});

test('dashboard collects 50 sessions', () => {
  const dir = tmp();
  process.env.CCTOWER_HOME = dir;
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cards'), { recursive: true });
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(
      path.join(dir, 'sessions', `s${i}.json`),
      JSON.stringify({ project: `proj-${i}`, verdict: i % 2 ? 'VERIFIED' : 'FAILED', waitingSince: i % 3 ? undefined : Date.now() }),
    );
  }
  const { collectState } = require('../src/ui/state');
  const st = collectState();
  assert.strictEqual(st.sessions.length, 50);
  assert.ok(st.sessions.every((s) => s.project && s.status));
});

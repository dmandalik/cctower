'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Seed an isolated state dir BEFORE requiring the UI (paths resolve env lazily,
// but set it up front to be safe).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-ui-'));
process.env.CCTOWER_HOME = dir;
process.env.CCTOWER_NO_OPEN = '1';

fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(dir, 'cards'), { recursive: true });
fs.writeFileSync(
  path.join(dir, 'snapshot.json'),
  JSON.stringify({ session: 'sess-a', model: 'claude-opus-4-8', modelName: 'Opus', contextPct: 42, contextSize: 200000, quota: { fiveHourPct: 61, weeklyPct: 34, fiveHourResets: '3:40pm' } }),
);
fs.writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify({ pairs: [{ estimate: 100, actual: 110 }], correction: 1.1 }));
fs.writeFileSync(path.join(dir, 'sessions', 'sess-a.json'), JSON.stringify({ verdict: 'VERIFIED', waitedSeconds: 12 }));
fs.writeFileSync(path.join(dir, 'sessions', 'sess-b.json'), JSON.stringify({ waitingSince: Date.now() }));
fs.writeFileSync(path.join(dir, 'cards', 'sess-a-1.md'), '# cctower landing report\n\n**Verdict:** VERIFIED\n**When:** 2026-07-15T10:00:00Z\n**Session:** sess-a\n');

const { collectState } = require('../src/ui/state');
const { start } = require('../src/ui/server');

test('collectState reports snapshot, sessions, cards, estimator', () => {
  const st = collectState();
  assert.strictEqual(st.snapshot.contextPct, 42);
  assert.strictEqual(st.estimator.correction, 1.1);
  assert.strictEqual(st.sessions.length, 2);
  const a = st.sessions.find((s) => s.id === 'sess-a');
  const b = st.sessions.find((s) => s.id === 'sess-b');
  assert.strictEqual(a.status, 'done');
  assert.strictEqual(a.contextPct, 42); // matches snapshot.session
  assert.strictEqual(b.status, 'waiting');
  assert.strictEqual(st.cards[0].verdict, 'VERIFIED');
});

test('server serves /state JSON and the index page', async () => {
  const server = start({ open: false, port: 0 });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const stateRes = await fetch(`${base}/state`);
    assert.strictEqual(stateRes.headers.get('content-type'), 'application/json');
    const st = await stateRes.json();
    assert.strictEqual(st.sessions.length, 2);

    const pageRes = await fetch(`${base}/`);
    assert.match(pageRes.headers.get('content-type'), /text\/html/);
    const html = await pageRes.text();
    assert.match(html, /CCTOWER/);
    assert.match(html, /\/state/);

    const missing = await fetch(`${base}/nope`);
    assert.strictEqual(missing.status, 404);
  } finally {
    server.close();
  }
});

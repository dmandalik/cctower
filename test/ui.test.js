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
// Guard: quota's local fallback must never scan the real ~/.claude in tests.
process.env.CCTOWER_CLAUDE_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-ui-proj-'));

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
fs.writeFileSync(
  path.join(dir, 'preflight.json'),
  JSON.stringify({ ts: '2026-07-16T12:00:00Z', session: 'sess-a', est: { low: 120, high: 138, content: 'prose' }, heavy: false, projected: 44, lint: null }),
);
fs.writeFileSync(
  path.join(dir, 'events.ndjson'),
  JSON.stringify({ ts: '2026-07-15T10:00:00Z', event: 'gate', est: { low: 98, high: 113, content: 'prose' }, heavy: false, projected: 42, lint: 'premium model for a small prompt' }) + '\n',
);

const { collectState } = require('../src/ui/state');
const { start } = require('../src/ui/server');

test('collectState reports snapshot, sessions, cards, estimator', () => {
  const st = collectState();
  assert.strictEqual(st.snapshot.contextPct, 42);
  assert.strictEqual(st.quota.source, 'official');
  assert.strictEqual(st.preflight.est.high, 138, 'preflight row comes from preflight.json');
  assert.strictEqual(st.estimator.correction, 1.1);
  assert.strictEqual(st.sessions.length, 2);
  const a = st.sessions.find((s) => s.id === 'sess-a');
  const b = st.sessions.find((s) => s.id === 'sess-b');
  assert.strictEqual(a.status, 'done');
  assert.strictEqual(a.contextPct, 42); // matches snapshot.session
  assert.strictEqual(b.status, 'waiting');
  assert.strictEqual(st.cards[0].verdict, 'VERIFIED');
});

test('preflight falls back to the events log when preflight.json is absent', () => {
  const pf = path.join(dir, 'preflight.json');
  const saved = fs.readFileSync(pf, 'utf8');
  fs.unlinkSync(pf);
  try {
    const st = collectState();
    assert.strictEqual(st.preflight.est.high, 113); // from the seeded gate event
    assert.match(st.preflight.lint, /premium model/);
  } finally {
    fs.writeFileSync(pf, saved);
  }
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
    assert.match(html, /cctower/i);
    assert.match(html, /\/state/);

    const missing = await fetch(`${base}/nope`);
    assert.strictEqual(missing.status, 404);
  } finally {
    server.close();
  }
});

test('POST /config updates config and shows up in /state', async () => {
  const server = start({ open: false, port: 0 });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'gate', mutedProjects: ['algo'] }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).mode, 'gate');

    const st = await (await fetch(`${base}/state`)).json();
    assert.strictEqual(st.config.mode, 'gate');
    assert.deepStrictEqual(st.config.mutedProjects, ['algo']);
  } finally {
    server.close();
  }
});

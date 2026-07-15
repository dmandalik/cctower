'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LAND = path.join(__dirname, '..', 'src', 'hooks', 'land.js');
const FIX = path.join(__dirname, 'fixtures');

function home(sessionSeed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-land-'));
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  if (sessionSeed) {
    fs.writeFileSync(
      path.join(dir, 'sessions', `${sessionSeed.id}.json`),
      JSON.stringify(sessionSeed.data),
    );
  }
  return dir;
}

function runLand(dir, { sessionId, transcript, stopActive = false }) {
  const input = {
    session_id: sessionId,
    hook_event_name: 'Stop',
    stop_hook_active: stopActive,
    transcript_path: path.join(FIX, transcript),
    cwd: os.tmpdir(), // not a repo -> no git diff, keeps the test hermetic
  };
  const res = spawnSync('node', [LAND], {
    input: JSON.stringify(input),
    env: { ...process.env, CCTOWER_HOME: dir },
    encoding: 'utf8',
  });
  return res;
}

function cards(dir) {
  const d = path.join(dir, 'cards');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')) : [];
}

function readCard(dir) {
  const files = cards(dir);
  return fs.readFileSync(path.join(dir, 'cards', files[0]), 'utf8');
}

test('VERIFIED transcript -> card + summary + recorded verdict', () => {
  const dir = home();
  const res = runLand(dir, { sessionId: 'sess-v', transcript: 'transcript-verified.jsonl' });
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /\[cctower\] VERIFIED/);
  assert.strictEqual(cards(dir).length, 1);
  assert.match(readCard(dir), /\*\*Verdict:\*\* VERIFIED/);
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-v.json'), 'utf8'));
  assert.strictEqual(sess.verdict, 'VERIFIED');
});

test('claimed-but-not-run transcript -> UNVERIFIED with a flagged claim', () => {
  const dir = home();
  const res = runLand(dir, { sessionId: 'sess-c', transcript: 'transcript-claimed.jsonl' });
  assert.match(res.stdout, /UNVERIFIED/);
  assert.match(res.stdout, /unbacked claim/);
  assert.match(readCard(dir), /claimed, not executed/);
});

test('failing-test transcript -> FAILED verdict', () => {
  const dir = home();
  const res = runLand(dir, { sessionId: 'sess-f', transcript: 'transcript-failed.jsonl' });
  assert.match(res.stdout, /\[cctower\] FAILED/);
  assert.match(readCard(dir), /\*\*Verdict:\*\* FAILED/);
});

test('self-tuning appends a calibration pair on a clean turn', () => {
  const dir = home({ id: 'sess-cal', data: { lastPrompt: { estimate: { low: 1500 } } } });
  runLand(dir, { sessionId: 'sess-cal', transcript: 'transcript-calibration.jsonl' });
  const cal = JSON.parse(fs.readFileSync(path.join(dir, 'calibration.json'), 'utf8'));
  assert.strictEqual(cal.pairs.length, 1);
  assert.deepStrictEqual(cal.pairs[0], { estimate: 1500, actual: 1300 });
  assert.ok(cal.correction > 0.85 && cal.correction < 0.88, `correction ${cal.correction}`);
});

test('self-tuning drops an implausible estimate/actual pair', () => {
  // estimate 10 vs actual 1300 -> ratio 130, outside the sanity band.
  const dir = home({ id: 'sess-bad', data: { lastPrompt: { estimate: { low: 10 } } } });
  runLand(dir, { sessionId: 'sess-bad', transcript: 'transcript-calibration.jsonl' });
  assert.ok(!fs.existsSync(path.join(dir, 'calibration.json')), 'no calibration for a garbage ratio');
});

test('60s cooldown: a second Stop for the session writes no new card', () => {
  const dir = home();
  runLand(dir, { sessionId: 'sess-cd', transcript: 'transcript-verified.jsonl' });
  const first = cards(dir).length;
  runLand(dir, { sessionId: 'sess-cd', transcript: 'transcript-verified.jsonl' });
  assert.strictEqual(cards(dir).length, first, 'no second card within the cooldown');
});

test('stop_hook_active guard: no card written', () => {
  const dir = home();
  const res = runLand(dir, {
    sessionId: 'sess-guard',
    transcript: 'transcript-verified.jsonl',
    stopActive: true,
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(cards(dir).length, 0);
});

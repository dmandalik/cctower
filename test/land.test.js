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

function runLand(dir, { sessionId, transcript, stopActive = false, log }) {
  const input = {
    session_id: sessionId,
    hook_event_name: 'Stop',
    stop_hook_active: stopActive,
    transcript_path: path.join(FIX, transcript),
    cwd: '/Users/x/projects/demo-proj', // not a repo -> no git diff; gives a project name
  };
  const env = { ...process.env, CCTOWER_HOME: dir };
  if (log) env.CCTOWER_NOTIFY_LOG = log;
  const res = spawnSync('node', [LAND], { input: JSON.stringify(input), env, encoding: 'utf8' });
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

test('duplicate Stop for the same turn writes no second card', () => {
  const dir = home();
  runLand(dir, { sessionId: 'sess-cd', transcript: 'transcript-verified.jsonl' });
  const first = cards(dir).length;
  runLand(dir, { sessionId: 'sess-cd', transcript: 'transcript-verified.jsonl' });
  assert.strictEqual(cards(dir).length, first, 'same turn mark -> deduped');
});

test('a NEW turn right after the last one still gets its card (no time cooldown)', () => {
  const dir = home();
  runLand(dir, { sessionId: 'sess-fast', transcript: 'transcript-verified.jsonl' });
  runLand(dir, { sessionId: 'sess-fast', transcript: 'transcript-question.jsonl' });
  assert.strictEqual(cards(dir).length, 2, 'consecutive turns both land');
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-fast.json'), 'utf8'));
  assert.strictEqual(sess.state, 'waiting', 'the question turn updates state despite following fast');
});

test('land sends a "done" notification and records state=done', () => {
  const dir = home();
  const log = path.join(dir, 'n.ndjson');
  runLand(dir, { sessionId: 'sess-d', transcript: 'transcript-verified.jsonl', log });
  const notes = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].title, /done · demo-proj/);
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-d.json'), 'utf8'));
  assert.strictEqual(sess.state, 'done');
});

test('AskUserQuestion evidence -> state=waiting + needs-input notification', () => {
  const dir = home();
  const log = path.join(dir, 'n.ndjson');
  runLand(dir, { sessionId: 'sess-ask', transcript: 'transcript-askuser.jsonl', log });
  const notes = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.match(notes[0].title, /needs your input/);
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-ask.json'), 'utf8'));
  assert.strictEqual(sess.state, 'waiting');
});

test('pending tool_use at Stop is NOT needs-input (interrupt/race), not waiting', () => {
  const dir = home();
  runLand(dir, { sessionId: 'sess-stall', transcript: 'transcript-pending-tool.jsonl' });
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-stall.json'), 'utf8'));
  assert.strictEqual(sess.state, 'done');
});

test('final message asking a question -> state=waiting + needs-input notification', () => {
  const dir = home();
  const log = path.join(dir, 'n.ndjson');
  runLand(dir, { sessionId: 'sess-q', transcript: 'transcript-question.jsonl', log });
  const notes = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].title, /needs your input · demo-proj/);
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-q.json'), 'utf8'));
  assert.strictEqual(sess.state, 'waiting');
});

test('land sends an "issue" notification (urgent) and records state=issue on FAILED', () => {
  const dir = home();
  const log = path.join(dir, 'n.ndjson');
  runLand(dir, { sessionId: 'sess-i', transcript: 'transcript-failed.jsonl', log });
  const notes = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].title, /issue · demo-proj/);
  assert.strictEqual(notes[0].urgent, true);
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-i.json'), 'utf8'));
  assert.strictEqual(sess.state, 'issue');
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

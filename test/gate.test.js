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

function runGate(inputObj, cctowerHome, notifyLog) {
  const env = { ...process.env, CCTOWER_HOME: cctowerHome, CCTOWER_NO_WATCHER: '1' };
  if (notifyLog) env.CCTOWER_NOTIFY_LOG = notifyLog;
  return spawnSync('node', [GATE], { input: JSON.stringify(inputObj), env, encoding: 'utf8' });
}

test('gate spawns the watcher daemon and records its pidfile', async () => {
  const dir = home();
  // Short daemon timings so even a missed kill can't outlive the suite.
  const env = { ...process.env, CCTOWER_HOME: dir, CCTOWER_WATCH_MS: '100', CCTOWER_WATCH_IDLE_MS: '500' };
  delete env.CCTOWER_NO_WATCHER;
  spawnSync('node', [GATE], { input: fs.readFileSync(path.join(FIX, 'prompt-basic.json'), 'utf8'), env, encoding: 'utf8' });
  const pf = path.join(dir, 'watcher.pid');
  // The daemon writes its pidfile asynchronously after the gate exits.
  let pid = 0;
  for (let i = 0; i < 40 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      pid = Number(fs.readFileSync(pf, 'utf8').trim());
    } catch {
      /* not yet */
    }
  }
  assert.ok(pid > 0, 'pidfile written by the daemon');
  assert.doesNotThrow(() => process.kill(pid, 0), 'daemon is alive');
  // Clean up and CONFIRM death — a leaked daemon must fail the test.
  process.kill(pid, 'SIGKILL');
  let dead = false;
  for (let i = 0; i < 40 && !dead; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      process.kill(pid, 0);
    } catch {
      dead = true;
    }
  }
  assert.ok(dead, 'daemon terminated');
});

test('advise mode with no snapshot prints a token line and exits 0', () => {
  const dir = home();
  const res = runGate(readFix('prompt-basic.json'), dir);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /\[cctower\]/);
  assert.match(res.stdout, /tokens/);
});

test('writes preflight.json so the widget can show the last pre-flight row', () => {
  const dir = home({ mode: 'advise', snapshot: 'snapshot-high.json' });
  runGate(readFix('prompt-heavy.json'), dir);
  const pf = JSON.parse(fs.readFileSync(path.join(dir, 'preflight.json'), 'utf8'));
  assert.ok(pf.est.high > 0);
  assert.strictEqual(typeof pf.projected, 'number');
  assert.match(pf.lint, /success criteria/);
});

test('preflight.json is written even in observe mode', () => {
  const dir = home({ mode: 'observe' });
  runGate(readFix('prompt-basic.json'), dir);
  assert.ok(fs.existsSync(path.join(dir, 'preflight.json')));
});

test('records state=working and notifies on the transition into working', () => {
  const dir = home();
  const log = path.join(dir, 'n.ndjson');
  // Seed a prior settled state so this prompt is a real done -> working change.
  fs.writeFileSync(path.join(dir, 'sessions', 'sess-basic-0001.json'), JSON.stringify({ state: 'done', project: 'demo' }));
  runGate(readFix('prompt-basic.json'), dir, log);

  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-basic-0001.json'), 'utf8'));
  assert.strictEqual(sess.state, 'working');
  const notes = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].title, /working/i);
});

test('does NOT notify working on the first prompt of a new session', () => {
  const dir = home();
  const log = path.join(dir, 'n.ndjson');
  runGate(readFix('prompt-basic.json'), dir, log); // no prior state
  assert.ok(!fs.existsSync(log), 'no working toast without a prior state');
});

test('advise records the turn (git ref + estimate) in the session file', () => {
  const dir = home();
  runGate(readFix('prompt-basic.json'), dir);
  const sess = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'sess-basic-0001.json'), 'utf8'));
  assert.ok(sess.lastPrompt);
  assert.ok(sess.lastPrompt.estimate.high > 0);
  assert.ok('gitRef' in sess.lastPrompt);
  assert.match(sess.transcriptPath, /transcript/, 'transcript path stored for the stall watcher');
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
    env: { ...process.env, CCTOWER_HOME: dir, CCTOWER_NO_WATCHER: '1' },
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

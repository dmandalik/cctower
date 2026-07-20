'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const card = require('../src/card');

test('awaitsInput requires a trailing question — polite closings do not count', () => {
  assert.ok(card.awaitsInput('Which database should I use — Postgres or SQLite?'));
  assert.ok(card.awaitsInput('Want me to also add tests?'));
  assert.ok(!card.awaitsInput('All tests pass. Fixed the null check.'));
  assert.ok(!card.awaitsInput('Done — the build is green.'));
  // These false-positives used to mark completed turns as "needs input".
  assert.ok(!card.awaitsInput('I scaffolded it. Let me know how you want to proceed.'));
  assert.ok(!card.awaitsInput('Done. Let me know if you want any adjustments.'));
});

test('looksLongRunning exempts tests, installs, watchers', () => {
  assert.ok(card.looksLongRunning('npm test'));
  assert.ok(card.looksLongRunning('pip install -r requirements.txt'));
  assert.ok(card.looksLongRunning('npm run dev'));
  assert.ok(!card.looksLongRunning('rm -rf build'));
  assert.ok(!card.looksLongRunning('git status'));
});

test('classifyCmd recognizes test / lint / build runners', () => {
  assert.strictEqual(card.classifyCmd('npm test'), 'test');
  assert.strictEqual(card.classifyCmd('pytest -q'), 'test');
  assert.strictEqual(card.classifyCmd('go test ./...'), 'test');
  assert.strictEqual(card.classifyCmd('eslint .'), 'lint');
  assert.strictEqual(card.classifyCmd('npm run build'), 'build');
  assert.strictEqual(card.classifyCmd('echo hello'), null);
});

test('VERIFIED: work changed, tests ran green, claims backed', () => {
  const r = card.analyze({
    uses: [
      { id: 'e1', name: 'Edit', input: { file_path: 'src/parser.js' } },
      { id: 'b1', name: 'Bash', input: { command: 'npm test' } },
    ],
    results: { b1: { isError: false, text: '12 passed' } },
    finalText: 'All tests pass. Fixed the parser.',
  });
  assert.strictEqual(r.verdict, 'VERIFIED');
  assert.ok(r.claims.every((c) => c.backed));
});

test('UNVERIFIED + "claimed, not executed" when tests were never run', () => {
  const r = card.analyze({
    uses: [{ id: 'w1', name: 'Write', input: { file_path: 'src/form.js' } }],
    results: {},
    finalText: 'All tests pass and lint is clean. I verified it works.',
  });
  assert.strictEqual(r.verdict, 'UNVERIFIED');
  const flagged = r.claims.filter((c) => !c.backed);
  assert.ok(flagged.length >= 1);
  assert.ok(flagged.some((c) => c.note.includes('not executed')));
});

test('FAILED when a matched test exits non-zero', () => {
  const r = card.analyze({
    uses: [
      { id: 'e1', name: 'Edit', input: { file_path: 'src/auth.js' } },
      { id: 'b1', name: 'Bash', input: { command: 'pytest -q' } },
    ],
    results: { b1: { isError: true, text: '1 failed\nexit code 1' } },
    finalText: 'Fixed the auth module; tests pass now.',
  });
  assert.strictEqual(r.verdict, 'FAILED');
  // the "tests pass" claim is contradicted by the failing run
  const tp = r.claims.find((c) => c.label === 'tests pass');
  assert.ok(tp && !tp.backed && /contradict/.test(tp.note));
});

test('NO-OP when nothing changed and nothing ran', () => {
  const r = card.analyze({ uses: [], results: {}, finalText: 'Here is how it works.' });
  assert.strictEqual(r.verdict, 'NO-OP');
});

test('renderSummary is 3–6 lines and leads with the verdict', () => {
  const r = card.analyze({
    uses: [{ id: 'w1', name: 'Write', input: { file_path: 'src/form.js' } }],
    results: {},
    finalText: 'All tests pass.',
  });
  const lines = card.renderSummary({ ...r, cardPath: '/tmp/x.md' });
  assert.ok(lines.length >= 3 && lines.length <= 6);
  assert.match(lines[0], /\[cctower\] UNVERIFIED/);
});

test('renderCard includes verdict, tests, and a claims section', () => {
  const r = card.analyze({
    uses: [
      { id: 'e1', name: 'Edit', input: { file_path: 'src/parser.js' } },
      { id: 'b1', name: 'Bash', input: { command: 'npm test' } },
    ],
    results: { b1: { isError: false, text: 'ok' } },
    finalText: 'All tests pass.',
  });
  const md = card.renderCard({ ...r, session: 'S', when: 'now' });
  assert.match(md, /# cctower landing report/);
  assert.match(md, /\*\*Verdict:\*\* VERIFIED/);
  assert.match(md, /Tests & builds/);
  assert.match(md, /npm test/);
});

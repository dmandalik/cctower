'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { lint, isHeavy, countFileRefs } = require('../src/lint');

test('isHeavy fires on scope verbs, size, and file fan-out', () => {
  assert.ok(isHeavy('refactor the auth module', 100));
  assert.ok(isHeavy('rewrite everything', 100));
  assert.ok(isHeavy('tiny tweak', 2500)); // large estimate
  assert.ok(isHeavy('touch a.js b.py c.md d.json', 100)); // 4 file refs
  assert.ok(!isHeavy('add a null check to the parser', 100));
});

test('countFileRefs counts path-like tokens', () => {
  assert.strictEqual(countFileRefs('edit src/a.js and lib/b.py, not foo'), 2);
  assert.strictEqual(countFileRefs('no files here'), 0);
});

test('lint: heavy task without success criteria', () => {
  const r = lint({ prompt: 'refactor the whole pipeline', estHigh: 300, heavy: true });
  assert.match(r.note, /success criteria/);
});

test('lint: heavy task WITH success criteria passes rule 1', () => {
  const r = lint({
    prompt: 'refactor the parser so that all existing tests still pass',
    estHigh: 300,
    heavy: true,
  });
  assert.ok(!r || !/success criteria/.test(r.note));
});

test('lint: vague scope', () => {
  const r = lint({ prompt: 'fix everything', estHigh: 20, heavy: false });
  assert.match(r.note, /vague scope/);
});

test('lint: premium model on a trivial prompt', () => {
  const r = lint({ prompt: 'say hi', estHigh: 40, heavy: false, model: 'claude-opus-4-8' });
  assert.match(r.note, /premium model/);
});

test('lint: huge inline paste suggests referencing the file', () => {
  const blob = '```js\n' + 'const x = 1;\n'.repeat(200) + '```';
  const r = lint({ prompt: 'here is the file ' + blob, estHigh: 50, heavy: false });
  assert.match(r.note, /large inline paste/);
});

test('lint: paste already in the transcript', () => {
  const body = 'function widget() { return 42; }\n'.repeat(60);
  const blob = '```js\n' + body + '```';
  const r = lint({
    prompt: 'look at this ' + blob,
    estHigh: 50,
    heavy: false,
    transcript: 'earlier the assistant showed:\n' + body,
  });
  assert.match(r.note, /already in context/);
});

test('lint: clean prompt yields no note', () => {
  const r = lint({
    prompt: 'add a null check in src/parser.js so the empty-input test passes',
    estHigh: 120,
    heavy: false,
  });
  assert.strictEqual(r, null);
});

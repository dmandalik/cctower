'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const T = require('../src/transcript');

const FIX = path.join(__dirname, 'fixtures');

test('slices the current turn and extracts tool uses/results', () => {
  const entries = T.readEntries(path.join(FIX, 'transcript-verified.jsonl'));
  const turn = T.sliceTurn(entries);
  const uses = T.toolUses(turn);
  assert.deepStrictEqual(uses.map((u) => u.name).sort(), ['Bash', 'Edit']);
  const results = T.toolResults(turn);
  assert.strictEqual(results.b1.isError, false);
  assert.match(T.finalAssistantText(turn), /All tests pass/);
});

test('turnInputDelta = this turn usage minus previous turn usage', () => {
  const entries = T.readEntries(path.join(FIX, 'transcript-calibration.jsonl'));
  // prev-turn last assistant in = 1000+0+8000 = 9000
  // this-turn last assistant in = 1700+0+9000 = 10700
  assert.strictEqual(T.turnInputDelta(entries), 1700);
  assert.strictEqual(T.humanCount(T.sliceTurn(entries)), 1);
});

test('readEntries tolerates a corrupt trailing line', () => {
  // no throw, and the good lines still parse
  const entries = T.readEntries(path.join(FIX, 'transcript-verified.jsonl'));
  assert.ok(entries.length >= 5);
});

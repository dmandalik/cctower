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

test('turnNewInput = new (non-cached) input of the turn, excluding cache_read', () => {
  const entries = T.readEntries(path.join(FIX, 'transcript-calibration.jsonl'));
  // first assistant after the human prompt: input 1100 + cache_creation 200,
  // cache_read (8200) is excluded.
  assert.strictEqual(T.turnNewInput(entries), 1300);
  assert.strictEqual(T.humanCount(T.sliceTurn(entries)), 1);
});

test('needsInputEvidence: AskUserQuestion in the final assistant message', () => {
  const turn = T.sliceTurn(T.readEntries(path.join(FIX, 'transcript-askuser.jsonl')));
  assert.strictEqual(T.needsInputEvidence(turn), 'ask_user_question');
});

test('needsInputEvidence: trailing tool_use with no result (permission stall)', () => {
  const turn = T.sliceTurn(T.readEntries(path.join(FIX, 'transcript-pending-tool.jsonl')));
  assert.strictEqual(T.needsInputEvidence(turn), 'pending_tool_use');
});

test('needsInputEvidence: negative — resolved tools + final text message', () => {
  const turn = T.sliceTurn(T.readEntries(path.join(FIX, 'transcript-verified.jsonl')));
  assert.strictEqual(T.needsInputEvidence(turn), null);
});

test('interruption markers are not prompts, and kill pending status', () => {
  const entries = T.readEntries(path.join(FIX, 'transcript-interrupted.jsonl'));
  const turn = T.sliceTurn(entries);
  // The turn anchors on the real prompt, not the "[Request interrupted…]" marker.
  assert.strictEqual(T.humanCount(turn), 1);
  assert.ok(T.hasInterruption(turn));
  assert.deepStrictEqual(T.pendingToolUses(turn), [], 'interrupted tool is not pending');
  assert.strictEqual(T.needsInputEvidence(turn), null);
});

test('readTailEntries parses the same turn as a full read', () => {
  const file = path.join(FIX, 'transcript-verified.jsonl');
  assert.strictEqual(T.readTailEntries(file).length, T.readEntries(file).length);
  assert.strictEqual(T.readTailEntries(file, 200).length < T.readEntries(file).length, true, 'tiny tail truncates from the front');
});

test('readEntries tolerates a corrupt trailing line', () => {
  // no throw, and the good lines still parse
  const entries = T.readEntries(path.join(FIX, 'transcript-verified.jsonl'));
  assert.ok(entries.length >= 5);
});

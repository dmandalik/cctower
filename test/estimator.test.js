'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const est = require('../src/estimator');

test('estimate returns a high-biased range, never a single number', () => {
  const r = est.estimate({ text: 'Summarize the meeting notes below in three bullets.', model: '' });
  assert.ok(r.low > 0);
  assert.ok(r.high > r.low, 'high must exceed low');
  // high is ~15% above the point estimate.
  assert.ok(Math.abs(r.high / r.low - 1.15) < 0.2);
});

test('known string -> deterministic small range', () => {
  // base("hello world") = 2 tokens (o200k_base); new-gen prose x1.4.
  const r = est.estimate({ text: 'hello world', model: 'claude-opus-4-8' });
  assert.strictEqual(r.base, 2);
  assert.strictEqual(r.content, 'prose');
  assert.strictEqual(r.gen, 'new');
  assert.strictEqual(r.low, 3); // round(2 * 1.4)
});

test('content sniff classifies the major kinds', () => {
  assert.strictEqual(est.sniff('{"a": 1, "b": [2, 3]}'), 'json');
  assert.strictEqual(est.sniff('def foo(x):\n    return x + 1'), 'python');
  assert.strictEqual(est.sniff('const add = (a, b) => a + b;'), 'js');
  assert.strictEqual(est.sniff('# Title\n\n- one\n- two\n[link](http://x)'), 'markdown');
  assert.strictEqual(est.sniff('これは日本語のテキストです。もっと文章。'), 'cjk');
  assert.strictEqual(est.sniff('Please write a short story about a fox.'), 'prose');
});

test('model generation map: known old vs new, unknown -> new', () => {
  for (const m of ['claude-3-5-sonnet', 'claude-sonnet-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'])
    assert.strictEqual(est.modelGeneration(m), 'old', m);
  for (const m of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-1', ''])
    assert.strictEqual(est.modelGeneration(m), 'new', m);
});

test('multiplier table: new-gen splits code, old-gen collapses it', () => {
  assert.strictEqual(est.multiplierFor('new', 'js'), 1.6);
  assert.strictEqual(est.multiplierFor('new', 'python'), 1.5);
  assert.strictEqual(est.multiplierFor('new', 'prose'), 1.4);
  assert.strictEqual(est.multiplierFor('old', 'python'), 1.2); // -> code
  assert.strictEqual(est.multiplierFor('old', 'js'), 1.2); // -> code
  assert.strictEqual(est.multiplierFor('old', 'prose'), 1.1);
});

test('correction factor scales the estimate and is clamped', () => {
  assert.strictEqual(est.clampCorrection(3), 2);
  assert.strictEqual(est.clampCorrection(0.1), 0.5);
  assert.strictEqual(est.clampCorrection(1), 1);

  const a = est.estimate({ text: 'refactor the parser', model: '', correction: 1 });
  const b = est.estimate({ text: 'refactor the parser', model: '', correction: 2 });
  assert.ok(b.low > a.low);
  assert.ok(Math.abs(b.low - a.low * 2) <= 1, 'correction 2 roughly doubles the estimate');
});

test('humanTokens formats compactly', () => {
  assert.strictEqual(est.humanTokens(820), '820');
  assert.strictEqual(est.humanTokens(1000), '1k');
  assert.strictEqual(est.humanTokens(1240), '1.2k');
  assert.strictEqual(est.humanTokens(15_200_000), '15.2M');
});

test('estimate() stays well under budget in-process', () => {
  const big = 'refactor '.repeat(2000);
  const t = process.hrtime.bigint();
  est.estimate({ text: big, model: 'claude-opus-4-8' });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 100, `estimate took ${ms.toFixed(1)}ms`);
});

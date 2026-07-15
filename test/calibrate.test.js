'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { appendPair, accuracy, median } = require('../src/calibrate');

test('median handles odd and even counts', () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(median([]), null);
});

test('appendPair records the pair and sets a median-ratio correction', () => {
  let cal = {};
  cal = appendPair(cal, 100, 130); // ratio 1.30
  cal = appendPair(cal, 100, 110); // ratio 1.10
  cal = appendPair(cal, 100, 120); // ratio 1.20
  assert.strictEqual(cal.pairs.length, 3);
  assert.strictEqual(cal.correction, 1.2); // median of [1.1,1.2,1.3]
});

test('correction is clamped to [0.5, 2.0]', () => {
  let cal = {};
  cal = appendPair(cal, 100, 900); // ratio 9 -> clamp 2.0
  assert.strictEqual(cal.correction, 2.0);
  cal = { pairs: [] };
  cal = appendPair(cal, 100, 10); // ratio 0.1 -> clamp 0.5
  assert.strictEqual(cal.correction, 0.5);
});

test('only the last 50 pairs drive the correction', () => {
  let cal = {};
  for (let i = 0; i < 60; i++) cal = appendPair(cal, 100, 100); // ratio 1.0
  cal = appendPair(cal, 100, 200); // one outlier
  // 50-window is mostly 1.0s -> median stays 1.0
  assert.strictEqual(cal.correction, 1.0);
});

test('accuracy is the median absolute % error', () => {
  const cal = { pairs: [
    { estimate: 100, actual: 110 }, // 10%
    { estimate: 100, actual: 80 },  // 20%
    { estimate: 100, actual: 130 }, // 30%
  ] };
  assert.strictEqual(accuracy(cal), 20);
  assert.strictEqual(accuracy({}), null);
});

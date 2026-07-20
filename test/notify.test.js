'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { notify, hasTerminalNotifier } = require('../src/notify');

test('CCTOWER_NOTIFY_LOG routes notifications to a file instead of the OS', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cct-nlog-')), 'n.ndjson');
  process.env.CCTOWER_NOTIFY_LOG = log;
  try {
    const status = notify({ title: 'Claude done', message: 'Turn finished.', urgent: false });
    assert.strictEqual(status, 'logged');
    const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].title, 'Claude done');
    assert.strictEqual(rows[0].message, 'Turn finished.');
    assert.strictEqual(rows[0].urgent, false);
  } finally {
    delete process.env.CCTOWER_NOTIFY_LOG;
  }
});

test('hasTerminalNotifier detects at runtime and never throws', () => {
  assert.strictEqual(typeof hasTerminalNotifier(), 'boolean');
  assert.strictEqual(hasTerminalNotifier(), hasTerminalNotifier(), 'result is memoized');
});

test('notify carries the per-session group through to the payload', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cct-nlog-')), 'n.ndjson');
  process.env.CCTOWER_NOTIFY_LOG = log;
  try {
    notify({ title: 't', message: 'm', group: 'sess-123' });
    const row = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    assert.strictEqual(row.group, 'sess-123');
  } finally {
    delete process.env.CCTOWER_NOTIFY_LOG;
  }
});

test('notify normalizes fields and never throws', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cct-nlog-')), 'n.ndjson');
  process.env.CCTOWER_NOTIFY_LOG = log;
  try {
    assert.doesNotThrow(() => notify({}));
    const row = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    assert.strictEqual(row.title, 'cctower');
    assert.strictEqual(row.message, '');
  } finally {
    delete process.env.CCTOWER_NOTIFY_LOG;
  }
});

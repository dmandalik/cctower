'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installer = require('../src/installer');
const { ROOT } = require('../src/paths');

const FIXTURE = path.join(__dirname, 'fixtures', 'settings-user-hooks.json');

// Point every state/settings path at a throwaway dir for one test.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-inst-'));
  process.env.CCTOWER_HOME = path.join(dir, 'home');
  process.env.CCTOWER_CLAUDE_SETTINGS = path.join(dir, 'settings.json');
  return dir;
}

function seedSettings(obj) {
  const p = process.env.CCTOWER_CLAUDE_SETTINGS;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

test('mergeSettings registers all three hook events + statusline', () => {
  const { settings } = installer.mergeSettings({});
  assert.ok(settings.hooks.UserPromptSubmit);
  assert.ok(settings.hooks.Notification);
  assert.ok(settings.hooks.Stop);
  // Stop wires both land + attention.
  const stopCmds = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(stopCmds.some((c) => c.includes('land.js')));
  assert.ok(stopCmds.some((c) => c.includes('attention.js')));
  assert.match(settings.statusLine.command, /statusline\.js/);
});

test('merge is idempotent — second pass is byte-identical', () => {
  const once = installer.mergeSettings({}).settings;
  const twice = installer.mergeSettings(once).settings;
  assert.strictEqual(JSON.stringify(once), JSON.stringify(twice));
});

test('merge preserves unrelated user hooks and a foreign statusline', () => {
  const user = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const { settings, foreignStatusline } = installer.mergeSettings(user);

  // User's own UserPromptSubmit hook survives alongside cctower's.
  const upsCmds = settings.hooks.UserPromptSubmit.flatMap((g) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(upsCmds.includes('echo user-hook'), 'user hook must be kept');
  assert.ok(upsCmds.some((c) => c.includes('gate.js')), 'cctower hook must be added');

  // A pre-existing custom statusline is not clobbered.
  assert.strictEqual(foreignStatusline, true);
  assert.strictEqual(settings.statusLine.command, 'my-own-statusline.sh');

  // Unrelated keys untouched.
  assert.deepStrictEqual(settings.permissions, { allow: ['Bash(git status)'] });
});

test('uninstall removes only cctower entries, restoring the user file', () => {
  const user = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const installed = installer.mergeSettings(user).settings;
  const cleaned = installer.removeSettings(installed);
  assert.deepStrictEqual(cleaned, user, 'removeSettings must invert mergeSettings');
});

test('init --dry-run produces a diff and writes nothing', () => {
  const dir = sandbox();
  seedSettings({ permissions: { allow: [] } });
  const before = fs.readFileSync(process.env.CCTOWER_CLAUDE_SETTINGS, 'utf8');

  const res = installer.init({ dryRun: true });
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(res.changed, true);
  assert.ok(res.diff.some((l) => l.startsWith('+') && l.includes('gate.js')));

  assert.strictEqual(
    fs.readFileSync(process.env.CCTOWER_CLAUDE_SETTINGS, 'utf8'),
    before,
    'dry-run must not modify settings',
  );
  assert.ok(!fs.existsSync(process.env.CCTOWER_HOME), 'dry-run must not create state dir');
});

test('init writes settings, backs up, and is idempotent on disk', () => {
  sandbox();
  seedSettings({ permissions: { allow: ['Bash(ls)'] } });

  const first = installer.init({});
  assert.strictEqual(first.changed, true);
  assert.ok(first.backupPath && fs.existsSync(first.backupPath), 'backup written');

  const written = JSON.parse(fs.readFileSync(process.env.CCTOWER_CLAUDE_SETTINGS, 'utf8'));
  assert.ok(installer.isInstalled(written).hooks);
  assert.ok(installer.isInstalled(written).statusline);
  assert.deepStrictEqual(written.permissions, { allow: ['Bash(ls)'] });

  // Second init changes nothing on disk.
  const before = fs.readFileSync(process.env.CCTOWER_CLAUDE_SETTINGS, 'utf8');
  const second = installer.init({});
  assert.strictEqual(second.changed, false);
  assert.strictEqual(fs.readFileSync(process.env.CCTOWER_CLAUDE_SETTINGS, 'utf8'), before);
});

test('init then uninstall returns settings to their original form', () => {
  sandbox();
  const original = { permissions: { allow: ['Bash(ls)'] } };
  seedSettings(original);
  installer.init({});
  const res = installer.uninstall();
  assert.strictEqual(res.changed, true);
  const after = JSON.parse(fs.readFileSync(process.env.CCTOWER_CLAUDE_SETTINGS, 'utf8'));
  assert.deepStrictEqual(after, original);
});

test('hook commands are absolute and point into this install', () => {
  assert.ok(installer.hookCommand('gate.js').includes(path.join(ROOT, 'src', 'hooks')));
  assert.ok(path.isAbsolute(installer.hookCommand('gate.js').replace(/^node /, '')));
});

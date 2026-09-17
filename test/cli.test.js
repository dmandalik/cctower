'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'cctower.js');

// Run the real CLI in a fully isolated environment (own state dir + settings).
function run(args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-cli-'));
  const merged = {
    ...process.env,
    CCTOWER_HOME: path.join(dir, 'home'),
    CCTOWER_CLAUDE_SETTINGS: path.join(dir, 'settings.json'),
    ...env,
  };
  const stdout = execFileSync('node', [BIN, ...args], {
    env: merged,
    encoding: 'utf8',
  });
  return { stdout, dir, env: merged };
}

test('init --dry-run prints a settings diff and touches nothing', () => {
  const { stdout, env } = run(['init', '--dry-run']);
  assert.match(stdout, /Would update/);
  assert.match(stdout, /\+.*gate\.js/);
  assert.match(stdout, /\+.*statusline\.js/);
  assert.ok(!fs.existsSync(env.CCTOWER_CLAUDE_SETTINGS), 'no settings file created');
  assert.ok(!fs.existsSync(env.CCTOWER_HOME), 'no state dir created');
});

test('off pauses, on resumes, off 2h sets an auto-resume', () => {
  const { stdout, env } = run(['off']);
  assert.match(stdout, /cctower off/);
  let cfg = JSON.parse(fs.readFileSync(path.join(env.CCTOWER_HOME, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.resumeAt, 0);

  execFileSync('node', [BIN, 'on'], { env, encoding: 'utf8' });
  cfg = JSON.parse(fs.readFileSync(path.join(env.CCTOWER_HOME, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.enabled, true);

  execFileSync('node', [BIN, 'off', '2h'], { env, encoding: 'utf8' });
  cfg = JSON.parse(fs.readFileSync(path.join(env.CCTOWER_HOME, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.enabled, false);
  assert.ok(cfg.resumeAt > Date.now() + 3600_000, 'resumeAt about two hours out');

  const st = execFileSync('node', [BIN, 'status'], { env, encoding: 'utf8' });
  assert.match(st, /power\s+OFF \(auto-resumes/);
});

test('off rejects an unparseable duration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-cli-'));
  const env = { ...process.env, CCTOWER_HOME: path.join(dir, 'home'), CCTOWER_CLAUDE_SETTINGS: path.join(dir, 's.json') };
  let failed = false;
  try {
    execFileSync('node', [BIN, 'off', 'tomorrow'], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /Can't parse duration/);
  }
  assert.ok(failed, 'exits non-zero');
});

test('status runs and reports install state', () => {
  const { stdout } = run(['status']);
  assert.match(stdout, /cctower status/);
  assert.match(stdout, /installed\s+hooks: no/);
  assert.match(stdout, /estimator\s+correction x1\.00/);
});

test('init then status reflects the install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-cli-'));
  const env = {
    ...process.env,
    CCTOWER_HOME: path.join(dir, 'home'),
    CCTOWER_CLAUDE_SETTINGS: path.join(dir, 'settings.json'),
  };
  execFileSync('node', [BIN, 'init'], { env, encoding: 'utf8' });
  const status = execFileSync('node', [BIN, 'status'], { env, encoding: 'utf8' });
  assert.match(status, /installed\s+hooks: yes\s+statusline: yes/);
});

test('unknown command exits non-zero with usage', () => {
  assert.throws(() => run(['bogus']), (err) => {
    assert.strictEqual(err.status, 1);
    assert.match(String(err.stderr), /Unknown command/);
    return true;
  });
});

test('--help prints usage', () => {
  const { stdout } = run(['--help']);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /cctower init/);
});

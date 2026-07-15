'use strict';

// `cctower status`: a health snapshot of the state dir and install — plain
// text, no colours, safe to run anytime.

const fs = require('fs');
const { statePaths, claudeSettingsPath, home } = require('./paths');
const { readJson, loadConfig } = require('./state');
const { isInstalled } = require('./installer');

function collect() {
  const p = statePaths();
  const config = loadConfig();
  const install = isInstalled();
  const snapshot = readJson(p.snapshot);
  const calibration = readJson(p.calibration);

  const correction =
    calibration && typeof calibration.correction === 'number'
      ? calibration.correction
      : 1.0;

  return {
    home: home(),
    homeExists: fs.existsSync(p.home),
    settingsPath: claudeSettingsPath(),
    config,
    install,
    snapshot,
    correction,
    calibrationPairs: (calibration && calibration.pairs && calibration.pairs.length) || 0,
  };
}

function ok(b) {
  return b ? 'yes' : 'no';
}

function render(s) {
  const lines = [];
  lines.push('cctower status');
  lines.push('');
  lines.push(`  state dir     ${s.home} (${s.homeExists ? 'present' : 'not created yet'})`);
  lines.push(`  mode          ${s.config.mode}`);
  lines.push(`  settings      ${s.settingsPath}`);
  lines.push(`  installed     hooks: ${ok(s.install.hooks)}  statusline: ${ok(s.install.statusline)}`);
  lines.push(
    s.snapshot
      ? `  last snapshot ${s.snapshot.model || '?'} · ctx ${s.snapshot.contextPct ?? '?'}%`
      : '  last snapshot none yet',
  );
  lines.push(
    `  estimator     correction x${s.correction.toFixed(2)} (${s.calibrationPairs} samples)`,
  );
  return lines.join('\n');
}

module.exports = { collect, render };

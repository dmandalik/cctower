#!/usr/bin/env node
'use strict';

// cctower CLI. Plain process.argv parsing, no framework.
// Subcommands: init [--dry-run] | uninstall | status | ui | report

const installer = require('../src/installer');
const status = require('../src/status');

const USAGE = `cctower — control tower for Claude Code

Usage:
  cctower init [--dry-run]   register hooks + statusline in ~/.claude/settings.json
  cctower uninstall          remove cctower's entries (leaves your own hooks)
  cctower status             state-dir + install health
  cctower ui                 local dashboard (coming in a later phase)
  cctower report             7-day summary (coming in a later phase)

Env:
  CCTOWER_HOME               state dir (default ~/.cctower)`;

function printDiff(res) {
  if (!res.changed) {
    console.log('No changes: cctower is already registered.');
    return;
  }
  console.log(`Would update ${res.settingsPath}:\n`);
  console.log(res.diff.join('\n'));
  if (res.foreignStatusline) {
    console.log(
      '\nNote: you already have a custom statusline — it will be kept, not replaced.',
    );
  }
}

function cmdInit(args) {
  const dryRun = args.includes('--dry-run');
  const res = installer.init({ dryRun });
  if (dryRun) {
    printDiff(res);
    return 0;
  }
  if (!res.changed) {
    console.log('cctower already installed — nothing to change.');
  } else {
    console.log(`Installed cctower into ${res.settingsPath}.`);
    if (res.backupPath) console.log(`Backed up previous settings to ${res.backupPath}.`);
    if (res.foreignStatusline) {
      console.log('Kept your existing custom statusline (not replaced).');
    }
  }
  return 0;
}

function cmdUninstall() {
  const res = installer.uninstall();
  if (!res.changed) console.log('cctower was not installed — nothing to remove.');
  else console.log(`Removed cctower's entries from ${res.settingsPath}.`);
  if (res.latestBackup) console.log(`Latest settings backup: ${res.latestBackup}`);
  return 0;
}

function cmdStatus() {
  console.log(status.render(status.collect()));
  return 0;
}

function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'init':
      return cmdInit(args);
    case 'uninstall':
      return cmdUninstall();
    case 'status':
      return cmdStatus();
    case 'ui':
    case 'report':
      console.log(`\`cctower ${cmd}\` arrives in a later phase.`);
      return 0;
    case undefined:
    case '-h':
    case '--help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.error(USAGE);
      return 1;
  }
}

// Fail open: never let cctower crash a shell. Log, exit 0, get out of the way.
try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(`[cctower] ${err && err.message ? err.message : err}`);
  process.exit(0);
}

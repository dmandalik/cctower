'use strict';

// Installs cctower into Claude Code's settings.json: registers our lifecycle
// hooks and statusline. Two guarantees the SPEC demands:
//   - idempotent: running init twice produces byte-identical settings.
//   - non-destructive: unrelated user hooks are preserved; init always backs
//     up the previous settings first.
// Schema verified against code.claude.com/docs (hooks, statusline).

const fs = require('fs');
const path = require('path');
const { ROOT, claudeSettingsPath, statePaths } = require('./paths');
const { readJson, writeJson, writeFileAtomic, ensureDirs, ensureConfig } =
  require('./state');

// event name -> hook scripts (resolved to absolute paths at install time).
// UserPromptSubmit/Stop/Notification take no matcher: they fire on every event.
const HOOK_EVENTS = {
  UserPromptSubmit: ['gate.js'],
  Notification: ['attention.js'],
  Stop: ['land.js', 'attention.js'],
};

function hookCommand(file) {
  return `node ${path.join(ROOT, 'src', 'hooks', file)}`;
}

function statuslineCommand() {
  return `node ${path.join(ROOT, 'src', 'statusline.js')}`;
}

// A command belongs to cctower iff it points back into this install.
function isCctowerCommand(cmd) {
  return typeof cmd === 'string' && cmd.includes(ROOT);
}

// Drop cctower's own handlers from an event's hook groups, leaving user
// handlers (and non-empty groups) exactly as they were.
function stripCctowerGroups(groups) {
  const out = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) {
      out.push(group);
      continue;
    }
    const kept = group.hooks.filter((h) => !isCctowerCommand(h && h.command));
    if (kept.length === 0) continue; // was a cctower-only group
    out.push(kept.length === group.hooks.length ? group : { ...group, hooks: kept });
  }
  return out;
}

// Pure: given current settings, return the merged settings plus a note if the
// user already has a non-cctower statusline (which we refuse to clobber).
function mergeSettings(current) {
  const out = current ? JSON.parse(JSON.stringify(current)) : {};
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};

  for (const [event, files] of Object.entries(HOOK_EVENTS)) {
    const groups = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const cleaned = stripCctowerGroups(groups);
    cleaned.push({
      hooks: files.map((f) => ({ type: 'command', command: hookCommand(f) })),
    });
    out.hooks[event] = cleaned;
  }

  const existing = out.statusLine;
  const foreignStatusline = !!(
    existing &&
    existing.command &&
    !isCctowerCommand(existing.command)
  );
  if (!foreignStatusline) {
    out.statusLine = { type: 'command', command: statuslineCommand() };
  }

  return { settings: out, foreignStatusline };
}

// Pure: remove every cctower entry, returning settings a fresh clone would have.
function removeSettings(current) {
  const out = current ? JSON.parse(JSON.stringify(current)) : {};
  if (out.hooks && typeof out.hooks === 'object') {
    for (const event of Object.keys(out.hooks)) {
      if (!Array.isArray(out.hooks[event])) continue;
      const cleaned = stripCctowerGroups(out.hooks[event]);
      if (cleaned.length === 0) delete out.hooks[event];
      else out.hooks[event] = cleaned;
    }
    if (Object.keys(out.hooks).length === 0) delete out.hooks;
  }
  if (out.statusLine && isCctowerCommand(out.statusLine.command)) {
    delete out.statusLine;
  }
  return out;
}

// Minimal LCS line diff, git-ish: '  ' unchanged, '- ' removed, '+ ' added.
function diffLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      lines.push('  ' + A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push('- ' + A[i++]);
    } else {
      lines.push('+ ' + B[j++]);
    }
  }
  while (i < n) lines.push('- ' + A[i++]);
  while (j < m) lines.push('+ ' + B[j++]);
  return lines;
}

function loadSettings() {
  return readJson(claudeSettingsPath(), {}) || {};
}

function timestamp() {
  // Local time, filename-safe: 2026-07-14T22-30-05.
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
}

// init: back up, merge idempotently, write. --dry-run computes the diff and
// touches nothing (not even the state dir).
function init({ dryRun = false } = {}) {
  const settingsPath = claudeSettingsPath();
  const before = loadSettings();
  const { settings: after, foreignStatusline } = mergeSettings(before);

  const beforeStr = JSON.stringify(before, null, 2);
  const afterStr = JSON.stringify(after, null, 2);
  const changed = beforeStr !== afterStr;

  if (dryRun) {
    return {
      dryRun: true,
      changed,
      diff: changed ? diffLines(beforeStr, afterStr) : [],
      settingsPath,
      foreignStatusline,
    };
  }

  ensureDirs();
  ensureConfig();

  let backupPath = null;
  if (fs.existsSync(settingsPath)) {
    backupPath = path.join(statePaths().backups, `settings.${timestamp()}.json`);
    writeFileAtomic(backupPath, fs.readFileSync(settingsPath, 'utf8'));
  }
  writeJson(settingsPath, after);

  return { dryRun: false, changed, backupPath, settingsPath, foreignStatusline };
}

// uninstall: strip only cctower's entries; point the user at the newest backup.
function uninstall() {
  const settingsPath = claudeSettingsPath();
  const before = loadSettings();
  const after = removeSettings(before);
  const changed = JSON.stringify(before) !== JSON.stringify(after);

  if (changed) writeJson(settingsPath, after);

  let latestBackup = null;
  try {
    const files = fs
      .readdirSync(statePaths().backups)
      .filter((f) => f.startsWith('settings.') && f.endsWith('.json'))
      .sort();
    if (files.length) latestBackup = path.join(statePaths().backups, files.at(-1));
  } catch {
    /* no backups dir yet */
  }

  return { changed, settingsPath, latestBackup };
}

// Is cctower currently registered in the given settings object?
function isInstalled(settings) {
  const s = settings || loadSettings();
  const inHooks =
    s.hooks &&
    Object.values(s.hooks).some(
      (groups) =>
        Array.isArray(groups) &&
        groups.some(
          (g) =>
            g &&
            Array.isArray(g.hooks) &&
            g.hooks.some((h) => isCctowerCommand(h && h.command)),
        ),
    );
  const inStatusline = !!(s.statusLine && isCctowerCommand(s.statusLine.command));
  return { hooks: !!inHooks, statusline: inStatusline };
}

module.exports = {
  HOOK_EVENTS,
  hookCommand,
  statuslineCommand,
  isCctowerCommand,
  mergeSettings,
  removeSettings,
  diffLines,
  loadSettings,
  init,
  uninstall,
  isInstalled,
};

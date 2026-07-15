'use strict';

// The state dir module: default config plus atomic JSON/text writes. Atomic =
// write a temp file in the same dir, then rename over the target, so a reader
// never sees a half-written file and a crash never corrupts state.

const fs = require('fs');
const path = require('path');
const { statePaths } = require('./paths');

const DEFAULT_CONFIG = {
  mode: 'advise', // observe | advise | gate
  contextWarnPct: 70,
  quotaWarnPct: 85,
  notifications: { done: true, needsInput: true, sound: false },
  lint: true,
  mutedProjects: [], // project names whose notifications are silenced
};

// Create the directories cctower writes into. Safe to call repeatedly.
function ensureDirs() {
  const p = statePaths();
  for (const dir of [p.home, p.sessions, p.cards, p.backups]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeJson(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

// Read + parse JSON, returning `fallback` on any missing/invalid file.
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Config merged over defaults, so new keys always have a sane value. The
// notifications sub-object is merged too, so a partial user config can't
// silently drop a sibling toggle.
function loadConfig() {
  const p = statePaths();
  const loaded = readJson(p.config, {}) || {};
  return {
    ...DEFAULT_CONFIG,
    ...loaded,
    notifications: { ...DEFAULT_CONFIG.notifications, ...(loaded.notifications || {}) },
  };
}

// Write defaults on first install; leave an existing config untouched.
function ensureConfig() {
  const p = statePaths();
  if (!fs.existsSync(p.config)) writeJson(p.config, DEFAULT_CONFIG);
  return loadConfig();
}

// Apply a whitelisted patch to config.json and persist it. The UI control
// panel calls this (via the server) so settings apply to every chat's next
// hook fire. Ignores unknown/invalid keys — never writes arbitrary data.
function updateConfig(patch) {
  const cur = loadConfig();
  const next = { ...cur };
  const clampPct = (n) => Math.min(100, Math.max(0, Math.round(n)));

  if (['observe', 'advise', 'gate'].includes(patch.mode)) next.mode = patch.mode;
  if (Number.isFinite(patch.contextWarnPct)) next.contextWarnPct = clampPct(patch.contextWarnPct);
  if (Number.isFinite(patch.quotaWarnPct)) next.quotaWarnPct = clampPct(patch.quotaWarnPct);
  if (typeof patch.lint === 'boolean') next.lint = patch.lint;
  if (patch.notifications && typeof patch.notifications === 'object') {
    next.notifications = { ...cur.notifications };
    for (const k of ['done', 'needsInput', 'sound']) {
      if (typeof patch.notifications[k] === 'boolean') next.notifications[k] = patch.notifications[k];
    }
  }
  if (Array.isArray(patch.mutedProjects)) {
    next.mutedProjects = [...new Set(patch.mutedProjects.filter((x) => typeof x === 'string'))].slice(0, 200);
  }

  writeJson(statePaths().config, next);
  return next;
}

// Append one JSON object as a line to the event log. Not atomic (appends
// don't need to be); best-effort, so a logging failure never breaks a hook.
function appendEvent(obj) {
  try {
    const p = statePaths();
    fs.mkdirSync(p.home, { recursive: true });
    fs.appendFileSync(p.events, JSON.stringify(obj) + '\n');
  } catch {
    /* logging is best-effort */
  }
}

module.exports = {
  DEFAULT_CONFIG,
  ensureDirs,
  writeFileAtomic,
  writeJson,
  readJson,
  loadConfig,
  ensureConfig,
  updateConfig,
  appendEvent,
};

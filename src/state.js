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

// Config merged over defaults, so new keys always have a sane value.
function loadConfig() {
  const p = statePaths();
  return { ...DEFAULT_CONFIG, ...(readJson(p.config, {}) || {}) };
}

// Write defaults on first install; leave an existing config untouched.
function ensureConfig() {
  const p = statePaths();
  if (!fs.existsSync(p.config)) writeJson(p.config, DEFAULT_CONFIG);
  return loadConfig();
}

module.exports = {
  DEFAULT_CONFIG,
  ensureDirs,
  writeFileAtomic,
  writeJson,
  readJson,
  loadConfig,
  ensureConfig,
};

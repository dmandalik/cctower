'use strict';

const fs = require('fs');

// Read all of stdin synchronously and JSON-parse it. Hooks and the statusline
// both receive their payload this way. Returns {} on empty/invalid input so
// callers can feature-detect fields rather than crash.
function readStdinJson() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

module.exports = { readStdinJson };

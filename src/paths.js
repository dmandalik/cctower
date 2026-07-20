'use strict';

// Filesystem locations cctower reads and writes. Everything is local; nothing
// here touches the network. Home resolves at call time so tests can point
// CCTOWER_HOME at a throwaway dir and isolate completely.

const os = require('os');
const path = require('path');

// Root of the installed cctower package (parent of this src/ dir). Used to
// build absolute `node <root>/src/...` hook commands and to recognise our own
// entries in the user's settings.
const ROOT = path.resolve(__dirname, '..');

function home() {
  return process.env.CCTOWER_HOME || path.join(os.homedir(), '.cctower');
}

// Resolved paths inside the state dir (see SPEC "State directory").
function statePaths() {
  const h = home();
  return {
    home: h,
    config: path.join(h, 'config.json'),
    snapshot: path.join(h, 'snapshot.json'),
    sessions: path.join(h, 'sessions'),
    cards: path.join(h, 'cards'),
    preflight: path.join(h, 'preflight.json'),
    calibration: path.join(h, 'calibration.json'),
    events: path.join(h, 'events.ndjson'),
    backups: path.join(h, 'backups'),
  };
}

// Claude Code's settings file. Overridable so tests never touch the real ~/.
function claudeSettingsPath() {
  return (
    process.env.CCTOWER_CLAUDE_SETTINGS ||
    path.join(os.homedir(), '.claude', 'settings.json')
  );
}

module.exports = { ROOT, home, statePaths, claudeSettingsPath };

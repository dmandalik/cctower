#!/usr/bin/env node
'use strict';

// Attention alerts. Registered on both Notification and Stop.
//   Notification -> classify permission (urgent) vs idle (normal), toast,
//                   and record when the session started waiting.
//   Stop         -> "done" toast (with the turn verdict when available),
//                   clear waiting-since, and accumulate the waited seconds.
// Config toggles are respected; notifications dedupe to one per session / 30s.
// Fail open: any error -> exit 0.

const path = require('path');
const { readStdinJson } = require('../io');
const { statePaths } = require('../paths');
const { loadConfig, readJson, writeJson, appendEvent } = require('../state');
const { notify } = require('../notify');

const DEDUPE_MS = 30_000;

function sessionFile(id) {
  return path.join(statePaths().sessions, `${id || 'unknown'}.json`);
}

// Human label for the session so a toast tells you WHICH chat pinged — the
// project folder name, falling back to a short session id.
function projectLabel(input) {
  if (input.cwd) return path.basename(String(input.cwd));
  if (input.session_id) return String(input.session_id).slice(0, 8);
  return 'session';
}

// Permission requests are urgent; everything else is "waiting for input".
function classify(input) {
  const hay = [input.type, input.notification_type, input.message, input.title]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/permission|approv|allow/.test(hay)) return 'permission';
  return 'idle';
}

function inCooldown(sess, now) {
  return typeof sess.lastNotifiedAt === 'number' && now - sess.lastNotifiedAt < DEDUPE_MS;
}

function handleNotification(input, cfg) {
  const now = Date.now();
  const file = sessionFile(input.session_id);
  const sess = readJson(file, {}) || {};

  const kind = classify(input);
  const urgent = kind === 'permission';
  const proj = projectLabel(input);
  sess.project = proj;
  sess.state = 'waiting'; // Claude paused for the user (permission or idle)
  const muted = Array.isArray(cfg.mutedProjects) && cfg.mutedProjects.includes(proj);

  // First wait wins until Stop clears it.
  if (typeof sess.waitingSince !== 'number') sess.waitingSince = now;

  let status = muted ? 'muted' : 'off';
  if (cfg.notifications.needsInput && !muted && !inCooldown(sess, now)) {
    const title = urgent ? `Claude needs permission · ${proj}` : `Claude is waiting · ${proj}`;
    const message =
      (input.message && String(input.message).slice(0, 180)) ||
      (urgent ? 'A tool call needs your approval.' : 'Waiting for your input.');
    status = notify({ title, message, urgent, sound: cfg.notifications.sound, group: input.session_id });
    sess.lastNotifiedAt = now;
  }

  writeJson(file, sess);
  appendEvent({
    ts: new Date().toISOString(),
    event: 'notification',
    session: input.session_id || null,
    kind,
    notify: status,
  });
}

// On Stop, attention only accounts for idle-waiting time. The done/issue
// notification and the final session state are owned by land.js (which knows
// the verdict), so they aren't split across two parallel Stop hooks.
function handleStop(input) {
  const now = Date.now();
  const file = sessionFile(input.session_id);
  const sess = readJson(file, {}) || {};
  let total = sess.waitedSeconds || 0;

  if (typeof sess.waitingSince === 'number') {
    // Re-read right before writing to preserve land.js's concurrent write.
    const fresh = readJson(file, {}) || {};
    fresh.waitedSeconds =
      (fresh.waitedSeconds || 0) + Math.max(0, Math.round((now - sess.waitingSince) / 1000));
    delete fresh.waitingSince;
    writeJson(file, fresh);
    total = fresh.waitedSeconds;
  }

  appendEvent({ ts: new Date().toISOString(), event: 'stop', session: input.session_id || null, waited: total });
}

function run() {
  const input = readStdinJson();
  const cfg = loadConfig();
  // Prefer the declared event; fall back to a shape heuristic.
  const event = input.hook_event_name || (input.message ? 'Notification' : 'Stop');
  if (event === 'Notification') handleNotification(input, cfg);
  else if (event === 'Stop') handleStop(input);
  return 0;
}

try {
  process.exit(run());
} catch {
  process.exit(0); // fail open
}

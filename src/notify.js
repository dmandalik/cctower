'use strict';

// Cross-platform desktop notifications behind one interface:
//   notify({ title, message, urgent, sound }) -> 'sent' | 'logged' | 'off' | ...
// macOS is implemented (osascript). Linux/Windows are stubs behind the same
// interface — full implementations are out of scope (SPEC). Never throws.
//
// Test/dev escape hatch: if CCTOWER_NOTIFY_LOG is set, notifications are
// appended there as JSON instead of hitting the OS, so tests never toast.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');

// Quote a string for an AppleScript literal.
function osaQuote(s) {
  return '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';
}

// terminal-notifier is far more reliable than osascript (its own notification
// permission, doesn't depend on Script Editor being enabled). Detect once.
let _tn = null;
function hasTerminalNotifier() {
  if (_tn === null) {
    try {
      execFileSync('which', ['terminal-notifier'], { stdio: 'ignore' });
      _tn = true;
    } catch {
      _tn = false;
    }
  }
  return _tn;
}

// Guaranteed audible ping — plays even when notification *display* is blocked.
// Non-blocking so the hook returns immediately.
function playSound() {
  try {
    spawn('afplay', ['/System/Library/Sounds/Ping.aiff'], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* no afplay */
  }
}

function macNotify({ title, message, urgent, sound, group }) {
  if (hasTerminalNotifier()) {
    const args = ['-title', String(title), '-message', String(message)];
    // Per-session group: newer alerts for the SAME chat replace the old one,
    // but different chats each keep their own notification (no collapsing).
    if (group) args.push('-group', `cctower-${String(group).replace(/[^\w.-]/g, '_')}`);
    execFileSync('terminal-notifier', args, { stdio: 'ignore', timeout: 3000 });
  } else {
    const script = `display notification ${osaQuote(message)} with title ${osaQuote(title)}`;
    execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 3000 });
  }
  // Sound follows the toggle for every alert type (independent of whether the
  // visual toast is allowed, so the user still gets a signal).
  if (sound) playSound();
}

function linuxNotify({ title, message }) {
  // Stub: use notify-send if it happens to be installed, else do nothing.
  try {
    execFileSync('notify-send', [String(title), String(message)], {
      stdio: 'ignore',
      timeout: 3000,
    });
  } catch {
    /* stub — richer Linux support is out of scope */
  }
}

function windowsNotify() {
  /* stub — Windows support is out of scope */
}

function notify(opts = {}) {
  const payload = {
    title: opts.title || 'cctower',
    message: opts.message || '',
    urgent: !!opts.urgent,
    sound: !!opts.sound,
    group: opts.group || null,
  };

  const log = process.env.CCTOWER_NOTIFY_LOG;
  if (log) {
    try {
      fs.appendFileSync(log, JSON.stringify(payload) + '\n');
    } catch {
      /* best-effort */
    }
    return 'logged';
  }

  try {
    switch (process.platform) {
      case 'darwin':
        macNotify(payload);
        return 'sent';
      case 'linux':
        linuxNotify(payload);
        return 'sent';
      case 'win32':
        windowsNotify(payload);
        return 'sent';
      default:
        return 'unsupported';
    }
  } catch {
    return 'failed'; // never throw — a broken toast must not break the hook
  }
}

module.exports = { notify };

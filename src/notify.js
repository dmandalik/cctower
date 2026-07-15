'use strict';

// Cross-platform desktop notifications behind one interface:
//   notify({ title, message, urgent, sound }) -> 'sent' | 'logged' | 'off' | ...
// macOS is implemented (osascript). Linux/Windows are stubs behind the same
// interface — full implementations are out of scope (SPEC). Never throws.
//
// Test/dev escape hatch: if CCTOWER_NOTIFY_LOG is set, notifications are
// appended there as JSON instead of hitting the OS, so tests never toast.

const { execFileSync } = require('child_process');
const fs = require('fs');

// Quote a string for an AppleScript literal.
function osaQuote(s) {
  return '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';
}

function macNotify({ title, message, sound }) {
  let script = `display notification ${osaQuote(message)} with title ${osaQuote(title)}`;
  if (sound) script += ' sound name "Ping"';
  execFileSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 3000 });
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

'use strict';

// Tiny localhost server for `cctower ui`. Serves one static page and a /state
// JSON endpoint the page polls. Random free port, prints the URL, opens the
// browser. Read-only viewer — nothing it serves mutates state.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { collectState } = require('./state');

const INDEX = path.join(__dirname, 'index.html');

// Open the panel as a chromeless "app window" if a Chromium browser is around
// (feels like a native pop-up, no tabs/address bar), else fall back to a normal
// browser tab. Each candidate is tried in order until one launches. Best-effort
// — the URL is always printed so the user can open it themselves.
function openAppWindow(url) {
  const app = `--app=${url}`;
  const size = '--window-size=760,920';
  let candidates;
  if (process.platform === 'darwin') {
    const chromium = (name) => ['open', ['-na', name, '--args', app, size]];
    candidates = [chromium('Google Chrome'), chromium('Microsoft Edge'), chromium('Brave Browser'), ['open', [url]]];
  } else if (process.platform === 'win32') {
    candidates = [
      ['cmd', ['/c', 'start', '', 'chrome', app, size]],
      ['cmd', ['/c', 'start', '', 'msedge', app, size]],
      ['cmd', ['/c', 'start', '', url]],
    ];
  } else {
    candidates = [
      ['google-chrome', [app, size]],
      ['chromium', [app, size]],
      ['microsoft-edge', [app, size]],
      ['xdg-open', [url]],
    ];
  }
  const tryNext = (i) => {
    if (i >= candidates.length) return;
    const [cmd, args] = candidates[i];
    try {
      execFile(cmd, args, (err) => {
        if (err) tryNext(i + 1);
      });
    } catch {
      tryNext(i + 1);
    }
  };
  tryNext(0);
}

function start({ open = true, port = 0, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    try {
      const url = (req.url || '').split('?')[0];
      if (url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(collectState()));
        return;
      }
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(INDEX));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('error');
    }
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${server.address().port}`;
    console.log(`cctower ui → ${url}  (Ctrl-C to quit)`);
    if (open && !process.env.CCTOWER_NO_OPEN) openAppWindow(url);
  });

  return server;
}

module.exports = { start };

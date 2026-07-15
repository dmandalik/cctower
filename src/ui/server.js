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

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    execFile(cmd, [url], () => {});
  } catch {
    /* opening is a convenience, not required */
  }
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
    if (open && !process.env.CCTOWER_NO_OPEN) openBrowser(url);
  });

  return server;
}

module.exports = { start };

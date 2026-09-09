// Tiny static server for running PromptForge at http://localhost instead of as a file.
//
// Why it exists: a page opened by double-clicking sends the browser origin "null", and local model
// servers (Ollama, LM Studio) answer that with 403. The same servers trust http://localhost pages by
// default, so serving the folder this way needs no OLLAMA_ORIGINS=* (which would let any website you
// visit talk to your local model). Node built-ins only; nothing to install.
//
//   npm run serve                 -> http://localhost:5173/
//   node serve.mjs --open         -> same, and opens it in the default browser (PromptForge.cmd does this)
//   PORT=8080 npm run serve
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const URL_ = `http://localhost:${PORT}/`;
const OPEN = process.argv.includes('--open');
const INSTANCE = createHash('sha256').update(ROOT).digest('hex');
const HEALTH_PATH = '/__promptforge_status';
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
if (PORT === 80) { HOSTS.add('localhost'); HOSTS.add('127.0.0.1'); }
// Expose the installable app only, never repository metadata, settings, or development files.
const PUBLIC_FILES = new Set([
  '/promptforge.html', '/sw.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png',
]);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const server = http.createServer((req, res) => {
  // Reject DNS-rebinding requests whose hostname is unrelated to the local app.
  if (!HOSTS.has((req.headers.host || '').toLowerCase())) { res.writeHead(403); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end();
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end(); } // a malformed path ("/%") must not crash the server
  if (pathname === HEALTH_PATH) {
    res.writeHead(204, { 'X-PromptForge-Instance': INSTANCE, 'Cache-Control': 'no-store' }); return res.end();
  }
  if (pathname === '/' || pathname === '/index.html') pathname = '/promptforge.html';
  if (!PUBLIC_FILES.has(pathname)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.normalize(path.join(ROOT, pathname));
  // Never serve anything outside this folder, whatever the path says.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function previousInstanceMatches() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port: PORT, path: HEALTH_PATH }, (response) => {
      // The headers identify the server; do not wait on another app's response body.
      response.destroy();
      resolve(response.statusCode === 204 && response.headers['x-promptforge-instance'] === INSTANCE);
    });
    request.setTimeout(1500, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    // Only reuse the port when it belongs to this copy of PromptForge.
    if (await previousInstanceMatches()) {
      console.log(`PromptForge is already running at ${URL_}`);
      if (OPEN) openBrowser(URL_);
    } else {
      console.error(`Port ${PORT} is in use by another application. Close it or choose a different port with PORT.`);
      process.exitCode = 1;
    }
    return;
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PromptForge: ${URL_}   (keep this window open; close it to stop)`);
  if (OPEN) openBrowser(URL_);
});

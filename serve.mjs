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
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const URL_ = `http://localhost:${PORT}/`;
const OPEN = process.argv.includes('--open');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end(); } // a malformed path ("/%") must not crash the server
  if (pathname === '/') pathname = '/promptforge.html';
  const file = path.normalize(path.join(ROOT, pathname));
  // Never serve anything outside this folder, whatever the path says.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // A previous launch is still serving; that one will do.
    console.log(`PromptForge is already running at ${URL_}`);
    if (OPEN) openBrowser(URL_);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PromptForge: ${URL_}   (keep this window open; close it to stop)`);
  if (OPEN) openBrowser(URL_);
});

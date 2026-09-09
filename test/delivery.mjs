import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = process.env.PF_DELIVERY_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t, port = undefined) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptforge-delivery-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    return fs.rm(dir, { recursive: true, force: true });
  });
  await fs.copyFile(path.join(ROOT, 'serve.mjs'), path.join(dir, 'serve.mjs'));
  await fs.mkdir(path.join(dir, '.git'));
  await fs.mkdir(path.join(dir, 'icons'));
  await fs.writeFile(path.join(dir, 'promptforge.html'), '<!doctype html><title>PromptForge fixture</title>');
  await fs.writeFile(path.join(dir, 'manifest.webmanifest'), '{}');
  await fs.writeFile(path.join(dir, '.git/config'), 'private repository configuration');
  await fs.writeFile(path.join(dir, '.env'), 'PRIVATE_TEST_SENTINEL');
  const selectedPort = port ?? await freePort();
  const launch = () => {
    const child = spawn(process.execPath, [path.join(dir, 'serve.mjs')], {
      env: { ...process.env, PORT: String(selectedPort) }, windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
    return { child, exited, output: () => output };
  };
  return { ...launch(), launch, url: `http://127.0.0.1:${selectedPort}` };
}

async function ready(server) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && server.child.exitCode === null) {
    try { if ((await fetch(server.url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Server did not start: ${server.output()}`);
}

test('local delivery serves the app but keeps repository files private', async (t) => {
  const server = await startServer(t);
  await ready(server);
  assert.match(await (await fetch(server.url)).text(), /PromptForge fixture/);
  assert.equal((await fetch(`${server.url}/manifest.webmanifest`)).status, 200);
  assert.equal((await fetch(`${server.url}/%`)).status, 400);
  for (const file of ['.git/config', '.env', 'serve.mjs']) {
    assert.equal((await fetch(`${server.url}/${file}`)).status, 404, `${file} must not be public`);
  }
});

test('local delivery rejects requests addressed to unrelated hostnames', async (t) => {
  const server = await startServer(t);
  await ready(server);
  const status = await new Promise((resolve, reject) => {
    http.get(server.url, { headers: { Host: 'unrelated.example' } }, (res) => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('a second launch recognizes the same PromptForge server', async (t) => {
  const server = await startServer(t);
  await ready(server);
  const duplicate = server.launch();
  assert.equal((await duplicate.exited)[0], 0);
  assert.match(duplicate.output(), /already running/i);
});

test('a busy port occupied by another app is reported as a startup failure', async (t) => {
  const other = http.createServer((_req, res) => res.end('Some other app'));
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const server = await startServer(t, other.address().port);
  assert.equal((await server.exited)[0], 1);
  assert.doesNotMatch(server.output(), /already running/i);
  assert.match(server.output(), /another application/i);
});

async function workerHarness() {
  const listeners = new Map();
  const stores = new Map();
  const scope = 'https://example.test/PromptForge/';
  const absolute = (req) => new URL(typeof req === 'string' ? req : req.url, scope).href;
  const network = { fetch: async () => new Response('<title>Healthy app</title>', { headers: { 'Content-Type': 'text/html' } }) };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(req) { return entries.get(absolute(req))?.clone(); },
        async put(req, response) { entries.set(absolute(req), response.clone()); },
        async add(req) { await this.put(req, await network.fetch(req)); },
        async addAll(requests) { for (const req of requests) await this.add(req); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(req) {
      for (const entries of stores.values()) if (entries.has(absolute(req))) return entries.get(absolute(req)).clone();
    },
  };
  const self = {
    location: new URL('sw.js', scope), registration: { scope },
    addEventListener(type, listener) { listeners.set(type, listener); },
    async skipWaiting() {}, clients: { async claim() {} },
  };
  vm.runInNewContext(await fs.readFile(path.join(ROOT, 'sw.js'), 'utf8'), {
    self, caches, URL, Response, fetch: (...args) => network.fetch(...args),
  });
  async function dispatch(type, request) {
    const pending = [];
    let response;
    listeners.get(type)({ request, waitUntil: (p) => pending.push(p), respondWith: (p) => { response = p; } });
    const result = await response;
    await Promise.all(pending);
    return result;
  }
  await dispatch('install');
  const navigation = (url = scope) => ({ url, method: 'GET', mode: 'navigate' });
  return { stores, network, dispatch, scope, navigation };
}

test('service-worker activation preserves caches owned by other apps and scopes', async () => {
  const worker = await workerHarness();
  const otherNames = ['other-app-v1', 'promptforge:https://example.test/OtherPromptForge/:v2'];
  for (const name of otherNames) worker.stores.set(name, new Map());
  await worker.dispatch('activate');
  for (const name of otherNames) assert.ok(worker.stores.has(name), `${name} must survive activation`);
});

test('failed navigations preserve the working offline app shell', async () => {
  for (const status of [404, 500]) {
    const worker = await workerHarness();
    worker.network.fetch = async () => new Response('Temporary server error', { status });
    await worker.dispatch('fetch', worker.navigation());
    worker.network.fetch = async () => { throw new TypeError('Offline'); };
    const offline = await worker.dispatch('fetch', worker.navigation());
    assert.equal(offline.status, 200);
    assert.match(await offline.text(), /Healthy app/);
  }
});

test('service worker leaves unrelated requests and API calls alone', async () => {
  const worker = await workerHarness();
  for (const req of [
    worker.navigation(`${worker.scope}missing-page`),
    { url: `${worker.scope}api/models`, method: 'GET', mode: 'cors' },
    { url: 'https://provider.test/models', method: 'GET', mode: 'cors' },
    { url: worker.scope, method: 'POST', mode: 'cors' },
  ]) assert.equal(await worker.dispatch('fetch', req), undefined, req.url);
});

test('successful online navigation refreshes the offline shell', async () => {
  const worker = await workerHarness();
  worker.network.fetch = async () => new Response('<title>Updated app</title>');
  await worker.dispatch('fetch', worker.navigation(`${worker.scope}index.html`));
  worker.network.fetch = async () => { throw new TypeError('Offline'); };
  assert.match(await (await worker.dispatch('fetch', worker.navigation())).text(), /Updated app/);
});

test('browser: the Pages subpath preserves other caches and opens the real app offline', async (t) => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: process.env.PF_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const app = await fs.readFile(path.join(ROOT, 'promptforge.html'));
  const worker = await fs.readFile(path.join(ROOT, 'sw.js'));
  let shellStatus = 200;
  let apiRequests = 0;
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/seed') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Cache setup</title>');
    } else if (['/PromptForge/', '/PromptForge/index.html', '/PromptForge/promptforge.html'].includes(pathname)) {
      res.writeHead(shellStatus, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(shellStatus === 200 ? app : 'Temporary server error');
    } else if (pathname === '/PromptForge/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(worker);
    } else if (pathname === '/PromptForge/api/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ request: ++apiRequests }));
    } else if (pathname === '/PromptForge/manifest.webmanifest' || /^\/PromptForge\/icons\/icon-(192|512|maskable-512)\.png$/.test(pathname)) {
      const file = pathname.slice('/PromptForge/'.length);
      res.writeHead(200, { 'Content-Type': file.endsWith('.png') ? 'image/png' : 'application/manifest+json' });
      res.end(await fs.readFile(path.join(ROOT, file)));
    } else { res.writeHead(404); res.end('Missing page'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const scope = `${origin}/PromptForge/`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/seed`);
  const oldOwnCache = `promptforge:${scope}:v1`;
  const otherCaches = ['other-app-v1', `promptforge:${origin}/OtherApp/:v1`];
  await page.evaluate(async (names) => {
    for (const name of names) await (await caches.open(name)).put('/sentinel', new Response('Keep me'));
  }, [oldOwnCache, ...otherCaches]);
  await page.goto(scope);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const names = await page.evaluate(() => caches.keys());
  for (const name of otherCaches) assert.ok(names.includes(name), `${name} survives activation`);
  assert.ok(!names.includes(oldOwnCache), 'obsolete caches belonging to this scope are cleaned up');
  assert.equal(await page.evaluate(async () => {
    await fetch('./api/models'); return (await (await fetch('./api/models')).json()).request;
  }), 2, 'same-origin API requests reach the network every time');
  for (const status of [404, 500]) {
    shellStatus = status;
    const response = await page.goto(scope);
    assert.equal(response.status(), 200, `HTTP ${status} falls back to the healthy shell`);
    assert.match(await page.title(), /^PromptForge/);
  }
  await context.setOffline(true);
  for (const suffix of ['', 'index.html', 'promptforge.html']) {
    const response = await page.goto(scope + suffix);
    assert.equal(response.status(), 200);
    assert.ok(response.fromServiceWorker());
    assert.match(await page.title(), /^PromptForge/);
    assert.ok(await page.locator('#idea').isVisible(), 'the real app is usable after an offline load');
  }
});

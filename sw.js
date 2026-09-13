// Cache only PromptForge's public files. API calls and other pages pass straight through.
// GitHub Pages apps share an origin, so cache ownership must include this worker's scope.
const CACHE_PREFIX = `promptforge:${self.registration.scope}:`;
const CACHE = `${CACHE_PREFIX}v2`;
const SHELL = new URL('./', self.location.href).href;
const SHELL_PATHS = new Set(['./', 'index.html', 'promptforge.html'].map((p) => new URL(p, SHELL).pathname));
const ASSET_PATHS = new Set([
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
].map((p) => new URL(p, SHELL).pathname));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    if (!SHELL_PATHS.has(url.pathname)) return;
    // Network first: an online load is always the latest version; offline falls back to the cached shell.
    e.respondWith(
      (async () => {
        // Storage can become unavailable after installation; keep online delivery working.
        const cache = await caches.open(CACHE).catch(() => null);
        try {
          const response = await fetch(req);
          if (!response.ok) return (await cache?.match(SHELL).catch(() => undefined)) || response;
          // Await the write to keep it alive; a storage failure must not hide a working online app.
          await cache?.put(SHELL, response.clone()).catch(() => {});
          return response;
        } catch {
          return (await cache?.match(SHELL).catch(() => undefined)) || Response.error();
        }
      })(),
    );
    return;
  }
  if (!ASSET_PATHS.has(url.pathname)) return;
  // Manifest and icons: cache first, fill this app's cache on first sight.
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE).catch(() => null);
      const hit = await cache?.match(req).catch(() => undefined);
      if (hit) return hit;
      const response = await fetch(req);
      if (response.ok) await cache?.put(req, response.clone()).catch(() => {});
      return response;
    })(),
  );
});

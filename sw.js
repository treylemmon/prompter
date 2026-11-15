/* Prompter — offline support.
   When you change any app file, bump VERSION so devices pick up the update. */
const VERSION = 'prompter-v5';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './parse.js',
  './gdrive.js',
  './app.js',
  './manifest.webmanifest',
  './lib/mammoth.browser.min.js',
  './lib/pdf.min.js',
  './lib/pdf.worker.min.js',
  './lib/jszip.min.js',
  './fonts/atkinson-400-normal.woff2',
  './fonts/atkinson-400-italic.woff2',
  './fonts/atkinson-700-normal.woff2',
  './fonts/atkinson-700-italic.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    })
  );
});

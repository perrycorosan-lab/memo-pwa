/* メモ PWA Service Worker — offline shell + app assets
 * Firebase CDN / API はキャッシュせずネットワークへ透過する
 */
const CACHE_NAME = 'memo-pwa-v8';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './sync.js',
  './firebase-config.js',
  './firebase-config.runtime.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/icon.svg'
];

/** Firebase / Google 関連は SW が横取りしない */
function isFirebaseOrCdn(url) {
  const host = url.hostname;
  return (
    host === 'www.gstatic.com' ||
    host === 'gstatic.com' ||
    host.endsWith('.google.com') ||
    host.endsWith('.googleapis.com') ||
    host.endsWith('.firebaseio.com') ||
    host.endsWith('.cloudfunctions.net') ||
    host.endsWith('.firebaseapp.com') ||
    host === 'esm.sh' ||
    host.endsWith('.esm.sh')
  );
}

function isAppShell(url) {
  const p = url.pathname;
  return (
    p.endsWith('/') ||
    p.endsWith('/index.html') ||
    p.endsWith('/app.js') ||
    p.endsWith('/sync.js') ||
    p.endsWith('/styles.css') ||
    p.endsWith('/sw.js') ||
    p.endsWith('/firebase-config.js') ||
    p.endsWith('/firebase-config.runtime.js')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(ASSETS).catch((err) => {
          console.warn('cache.addAll partial failure', err);
          return Promise.all(
            ASSETS.map((u) => cache.add(u).catch(() => undefined))
          );
        })
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (isFirebaseOrCdn(url)) {
    return;
  }

  if (url.pathname.endsWith('/firebase-config.local.js')) {
    event.respondWith(fetch(request).catch(() => new Response('', { status: 404 })));
    return;
  }

  // HTML/JS/CSS はネットワーク優先（更新がすぐ届く）
  if (isAppShell(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

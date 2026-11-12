/* Кэш оболочки приложения + приём файлов из системного «Поделиться». */
const CACHE = 'inbox-shell-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('inbox-app', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('shared')) db.createObjectStore('shared', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function storePut(store, value) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite').objectStore(store).put(value);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

async function handleShare(request) {
  const back = (query) => Response.redirect(location.origin + '/' + query, 303);
  try {
    const form = await request.formData();
    const entry = {
      id: Date.now().toString(36),
      at: new Date().toISOString(),
      title: String(form.get('title') || ''),
      text: String(form.get('text') || ''),
      url: String(form.get('url') || ''),
      files: []
    };
    for (const f of form.getAll('files')) {
      if (f && typeof f === 'object' && f.name) {
        entry.files.push({ name: f.name, type: f.type || '', blob: f });
      }
    }
    if (!entry.files.length && !entry.text && !entry.url) return back('?share_failed=1');
    await storePut('shared', entry);
    return back('?shared=' + encodeURIComponent(entry.id));
  } catch {
    return back('?share_failed=1');
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname === '/share') {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('index.html')))
  );
});

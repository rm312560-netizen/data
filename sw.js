// 離線用：App 檔案存在手機上（報價仍需要網路）。改版時把 VERSION 加 1。
const VERSION = 'tsdata-v4';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'calc.js', 'db.js', 'config.js', 'manifest.webmanifest',
  'vendor/sql-wasm.js', 'vendor/sql-wasm.wasm', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== VERSION).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
// 只處理 App 自己的檔案；報價、轉接站的請求直接走網路
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('離線中', { status: 503 });
  }));
});

// 推播通知（轉接站送來的到價提醒、停損停利、除息提醒）
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: '資料查詢', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '資料查詢', { body: d.body || '', tag: d.tag || undefined, data: { url: d.url || './' }, icon: 'icons/icon-192.png' }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});

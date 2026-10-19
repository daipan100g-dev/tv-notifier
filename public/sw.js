// The build script injects an asset list and a content-derived cache version.
const CACHE = 'tv-notifier-dev';
const SHELL = ['./', './index.html', './icon-192.png', './icon-512.png'];
const scope = new URL(self.registration.scope);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('tv-notifier-') && key !== CACHE).map(key => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== scope.origin ||
    !url.pathname.startsWith(scope.pathname) || url.pathname.includes('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(new URL('./index.html', scope))));
    return;
  }
  if (!SHELL.some(path => new URL(path, scope).href === url.href)) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Always show a visible notification on iOS. */ }
  event.waitUntil(self.registration.showNotification(data.title || '放送メモ', {
    body: data.body || '新しい放送予定があります。アプリで確認してください。',
    tag: data.tag || 'tv-notifier',
    icon: new URL('./icon-192.png', scope).href,
    data: { url: data.url || scope.href },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  let target = scope.href;
  try {
    const url = new URL(event.notification.data?.url, scope);
    const hosts = ['nhk.jp', 'nhk.or.jp', 'web.nhk', 'tbs.co.jp', 'ntv.co.jp'];
    if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname) ||
      url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) target = url.href;
  } catch { /* Fall back to this installed app. */ }
  event.waitUntil(self.clients.openWindow(target));
});

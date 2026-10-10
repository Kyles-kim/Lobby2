// Lobby service worker — 화면 파일만 캐시하고, 서버(Supabase) 요청은 항상 네트워크로 보냅니다.
// 서버가 보내는 휴대폰 알림(일정 알림)도 여기서 받아 알림 센터에 띄웁니다.
const CACHE = 'lobby2-v15';
const ASSETS = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 새 버전을 먼저 받고, 오프라인이면 저장본 사용
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))));
});

// 휴대폰 알림: 앱이 꺼져 있어도 알림 센터에 띄우고, 앱이 열려 있으면 화면에서도 울리도록 전달한다
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Lobby2 알림', {
      body: d.body || '', tag: d.tag || 'lobby2', renotify: true, requireInteraction: true, lang: 'ko',
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', vibrate: [400, 200, 400, 200, 800], data: d,
    });
    if (d.alarm) (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).forEach(c => c.postMessage({ type: 'alarm', alarm: d.alarm }));
  })());
});
// 알림을 누르면 열려 있는 Lobby2 화면으로 가고, 없으면 새로 연다
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./#talk');
  })());
});

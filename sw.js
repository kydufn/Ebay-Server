// Minimaler Service Worker für das Reseller Center.
// Zweck: macht die Seite am Handy "installierbar" (Zum-Home-Bildschirm mit App-Gefühl).
// Wichtig: /api/-Anfragen werden NIE angefasst oder gecacht — Bestands- und
// Verkaufsdaten kommen immer frisch vom Server. Nur die Oberfläche selbst wird
// als Offline-Fallback zwischengespeichert.

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;          // nur lesende Anfragen
  if (url.pathname.startsWith('/api/')) return;     // API IMMER live, nie cachen
  if (url.origin !== location.origin) return;       // fremde Adressen (z. B. eBay-Bilder) nicht anfassen

  // Netzwerk zuerst (immer aktuellste Version), Cache nur als Offline-Notlösung
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open('rc-static-v1').then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});

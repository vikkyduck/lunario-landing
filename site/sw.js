/* Service worker лендинга lunario.online.
   Две задачи: дать браузеру основание предложить установку приложения
   (без зарегистрированного SW кнопка «Установить» не появляется)
   и показать сайт при пропавшей сети.

   Зона приложения (/app/) обслуживается собственным SW — сюда не лезем:
   у него более узкая зона, поэтому там он и остаётся главным. */
const CACHE = 'lunario-site-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // приложение, его API и заявки лендинга всегда идут в сеть напрямую
  if (url.pathname.startsWith('/app') || url.pathname.startsWith('/api') || url.pathname.startsWith('/admin')) return;

  // сначала сеть, чтобы правки лендинга появлялись сразу; кэш — запасной путь без связи
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const copy = fresh.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const home = await caches.match('/');
        if (home) return home;
      }
      throw err;
    }
  })());
});

/* Push delivery only. Booking pages and payment data always use the network. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let test = false;
  try { test = event.data?.json()?.tag === 'paddle-rage-test'; } catch (_) { /* Use generic copy. */ }
  event.waitUntil(self.registration.showNotification('Paddle Rage', {
    body: test ? 'Phone notifications are ready on this device.' : 'A payment needs review. Sign in to view the details.',
    icon: '/app-icon-192.png',
    tag: test ? 'paddle-rage-test' : 'paddle-rage-payment-review',
    data: { url: '/admin#payreview' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL('/admin#payreview', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const admin = windows.find(client => new URL(client.url).origin === self.location.origin && /^\/admin(?:\.html)?$/.test(new URL(client.url).pathname));
    if (admin) { await admin.navigate(url); return admin.focus(); }
    return self.clients.openWindow(url);
  })());
});

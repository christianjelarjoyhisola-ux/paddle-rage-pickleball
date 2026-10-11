/* Push delivery only. Booking pages and payment data always use the network. */
importScripts('/payment-review-link.js');
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let test = false, review = null;
  try { const payload = event.data?.json(); test = payload?.tag === 'paddle-rage-test'; review = test ? null : self.PaymentReviewLink.target(payload?.review); } catch (_) { /* Use generic copy. */ }
  event.waitUntil(self.registration.showNotification('Paddle Rage', {
    body: test ? 'Phone notifications are ready on this device.' : 'A payment needs review. Sign in to view the details.',
    icon: '/app-icon-192.png',
    tag: test ? 'paddle-rage-test' : review ? `paddle-rage-review:${review.kind}:${review.subject_id}` : 'paddle-rage-payment-review',
    data: { review, url: self.PaymentReviewLink.path(review) },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(self.PaymentReviewLink.path(event.notification.data?.review), self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const local = windows.filter(client => new URL(client.url).origin === self.location.origin);
    const admin = local.find(client => /^\/admin(?:\.html)?$/.test(new URL(client.url).pathname));
    // An installed app can be sitting on the booking homepage or sign-in page.
    // Reuse that window so a notification opens the review screen in the app.
    const app = admin || local.find(client => /^\/(?:index(?:\.html)?|login(?:\.html)?)?$/.test(new URL(client.url).pathname));
    if (app) {
      try {
        const navigated = await app.navigate(url);
        return await (navigated || app).focus();
      } catch (_) { /* A closed/stale window must not swallow the notification tap. */ }
    }
    return self.clients.openWindow(url);
  })());
});

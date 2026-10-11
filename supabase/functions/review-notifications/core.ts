export function validSubscription(value: any) {
  try {
    const u = new URL(value.endpoint);
    const host = u.hostname;
    const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
      host.endsWith('.push.services.mozilla.com') || host === 'web.push.apple.com' || host.endsWith('.web.push.apple.com') || host.endsWith('.notify.windows.com');
    if (!allowed || u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || u.href.length > 2048) return null;
    if (!/^[A-Za-z0-9_-]{87}=?$/.test(value.keys?.p256dh) || !/^[A-Za-z0-9_-]{22}={0,2}$/.test(value.keys?.auth)) return null;
    return { endpoint: u.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
  } catch { return null; }
}
export const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
import { validReviewTarget } from '../_shared/payment-review-link.ts';
export const pushPayload = (test = false, payment: unknown = null) => {
  const review = test ? null : validReviewTarget(payment);
  return { title: 'Paddle Rage', body: test ? 'Phone notifications are ready on this device.' : 'A payment needs review. Sign in to view the details.',
    tag: test ? 'paddle-rage-test' : review ? `paddle-rage-review:${review.kind}:${review.subject_id}` : 'paddle-rage-payment-review',
    ...(review ? { review } : {}) };
};
export async function digest(s: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2,'0')).join('');
}

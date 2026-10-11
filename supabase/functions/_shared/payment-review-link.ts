export type ReviewTarget = { kind: string; subject_id: string };
export function validReviewTarget(value: unknown): ReviewTarget | null {
  const p = value as ReviewTarget | null;
  return p && ['booking','host_balance','open_play','host_session'].includes(p.kind) &&
    typeof p.subject_id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(p.subject_id)
    ? { kind:p.kind, subject_id:p.subject_id } : null;
}
export function paymentReviewUrl(value: unknown) {
  const p=validReviewTarget(value);
  return 'https://paddleragecdo.ph/admin' + (p ? `?review_kind=${encodeURIComponent(p.kind)}&review_id=${encodeURIComponent(p.subject_id)}` : '') + '#payreview';
}

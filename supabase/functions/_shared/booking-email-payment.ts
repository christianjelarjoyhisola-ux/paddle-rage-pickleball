const PARTIAL_PAYMENT_STATES = new Set([
  "downpayment_paid",
  "deposit_retained",
]);

/**
 * Returns only money represented by a settled payment state. A stored
 * downpayment amount is merely the expected amount while a booking remains
 * unpaid, pending, or under verification and must never be described as paid.
 */
export function confirmedBookingPaidAmount(input: {
  paymentStatus: unknown;
  total: unknown;
  downpayment: unknown;
}): number {
  const status = String(input.paymentStatus || "").trim().toLowerCase();
  const total = Math.max(0, Number(input.total || 0));
  const downpayment = Math.max(0, Number(input.downpayment || 0));
  if (status === "paid") return total;
  if (PARTIAL_PAYMENT_STATES.has(status)) return Math.min(total, downpayment);
  return 0;
}

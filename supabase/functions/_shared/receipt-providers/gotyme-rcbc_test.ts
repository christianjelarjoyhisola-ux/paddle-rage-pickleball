import { parseRcbcReceipt, verifyRcbcReceipt } from "./rcbc.ts";
const eq = (a: unknown, b: unknown) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error(JSON.stringify({ actual: a, expected: b }));
  }
};
// Sanitized transcription preserves the uploaded receipt's actual Vision ordering.
const observed = `3:23 1
instaFay
To
Transferred
P400.00
Share
TEST C*
**** O*
*7890
=
Rizal Commercial Banking Corp
(RCBC)
From
PAYER N**** S********
********6243
GoTyme Bank
Amount
P400.00
Fee
$9.00
Total
Trace ID
Reference No.
Date
Get help
P409.00
999999
ITO260926072399999
26 Sep 2026 at 3:23 PM
Instant
>
✓`;
const context = {
  typedReference: "ITO260926072399999",
  expectedAmount: 400,
  pricingAvailable: true,
  amountTolerance: .01,
  expectedRecipientNumber: "1234567890",
  expectedRecipientName: "TEST COURT OWNER",
  bookingStartedAt: "2026-09-26T07:22:14.137Z",
  bookingStartedDate: "2026-09-26",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};
const run = (raw = observed, patch = {}) => {
  const c = { ...context, ...patch };
  const p = parseRcbcReceipt(raw, { typedReference: c.typedReference });
  return { p, v: verifyRcbcReceipt(p, c) };
};
Deno.test("GoTyme RCBC actual column ordering parses independent recipient, amount, reference and date", () => {
  const { p, v } = run();
  eq(v.flags, []);
  eq(p.amount.amount, 400);
  eq(p.timestamp.instant, "2026-09-26T07:23:00.000Z");
  eq(p.recipient.nameRaw, "TEST C***** O*");
  eq(p.recipient.accountRaw, "*7890");
  eq(p.traceReference, "999999");
  eq(p.sourceParserVersion, "gotyme_to_rcbc_v1");
  eq(v.recipientComparison.name, "masked_compatible");
});
Deno.test("GoTyme RCBC clean row-order receipt also passes", () => {
  const raw = observed.replace(
    "To\nTransferred\nP400.00\nShare",
    "Transferred\nP400.00\nShare\nTo",
  ).replace("TEST C*\n**** O*", "TEST COURT OWNER").replace(
    "Total\nTrace ID\nReference No.\nDate\nGet help\nP409.00\n999999\nITO260926072399999\n26 Sep 2026 at 3:23 PM",
    "Total\nP409.00\nTrace ID\n999999\nReference No.\nITO260926072399999\nDate\n26 Sep 2026 at 3:23 PM\nGet help",
  );
  eq(run(raw).v.flags, []);
});
for (
  const [name, raw, patch, flag] of [
    [
      "bank fee is not payment",
      observed,
      { expectedAmount: 409 },
      "AMOUNT_MISMATCH",
    ],
    [
      "wrong suffix",
      observed.replace("*7890", "*7891"),
      {},
      "RECEIVER_ACCOUNT_MISMATCH",
    ],
    [
      "three digits",
      observed.replace("*7890", "*890"),
      {},
      "RECEIVER_ACCOUNT_UNREADABLE",
    ],
    [
      "wrong name",
      observed.replace("TEST C*", "OTHER C*"),
      {},
      "RECEIVER_NAME_MISMATCH",
    ],
    [
      "wrong middle initial",
      observed.replace("TEST C*", "TEST Z*"),
      {},
      "RECEIVER_NAME_MISMATCH",
    ],
    [
      "wrong bank",
      observed.replace("(RCBC)", "(GCash)"),
      {},
      "RCBC_DESTINATION_MISMATCH",
    ],
    [
      "missing timestamp",
      observed.replace("26 Sep 2026 at 3:23 PM", ""),
      {},
      "TIME_UNREADABLE",
    ],
    [
      "wrong reference",
      observed,
      { typedReference: "ITO260926072399998" },
      "REF_MISMATCH",
    ],
    [
      "trace is not the full reference",
      observed,
      { typedReference: "999999" },
      "REF_MISMATCH",
    ],
    [
      "wrong fee arithmetic",
      observed.replace("P409.00", "P419.00"),
      {},
      "AMOUNT_CONFLICT",
    ],
    [
      "wrong header amount",
      observed.replace("Transferred\nP400.00", "Transferred\nP500.00"),
      {},
      "AMOUNT_CONFLICT",
    ],
    [
      "failed transfer",
      observed + "\nFailed",
      {},
      "TRANSFER_STATUS_UNREADABLE",
    ],
    [
      "missing trace",
      observed.replace("999999\nITO", "\nITO"),
      {},
      "GOTYME_RCBC_TRACE_UNREADABLE",
    ],
    [
      "stale transfer",
      observed,
      { bookingStartedAt: "2026-09-25T07:22:00Z" },
      "TIME_EXPIRED",
    ],
    [
      "unknown pricing",
      observed,
      { pricingAvailable: false },
      "PRICING_UNAVAILABLE",
    ],
    [
      "duplicated reference labels",
      observed + "\nReference No.\nITO260926072399998",
      {},
      "REF_UNREADABLE",
    ],
  ] as const
) {
  Deno.test(`GoTyme RCBC rejects ${name}`, () => {
    const flags = run(raw, patch).v.flags;
    if (!flags.includes(flag)) throw Error(JSON.stringify(flags));
  });
}
Deno.test("GoTyme RCBC does not synthesize missing reference from customer input", () => {
  eq(run(observed.replace("ITO260926072399999", "")).p.reference.value, null);
});
Deno.test("GoTyme RCBC full reference is claimed in RCBC and sending-bank namespaces", () => {
  eq(run().v.dedupeKeys.map((k) => k.key), [
    "rcbc:ITO260926072399999",
    "gotyme:ITO260926072399999",
  ]);
});
Deno.test("GoTyme RCBC ignores sender account even if its suffix matches merchant", () => {
  const flags = run(
    observed.replace("*7890", "*1234").replace(
      "********6243",
      "********7890",
    ),
  ).v.flags;
  if (!flags.includes("RECEIVER_ACCOUNT_MISMATCH")) {
    throw Error("Sender account used");
  }
});

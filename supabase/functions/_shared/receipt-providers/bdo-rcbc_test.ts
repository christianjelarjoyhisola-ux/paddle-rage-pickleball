import {
  parseRcbcReceipt,
  rcbcCriticalDigitsReadable,
  verifyRcbcReceipt,
} from "./rcbc.ts";
const eq = (a: unknown, b: unknown) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error(JSON.stringify({ actual: a, expected: b }));
  }
};
// Sanitized actual Vision ordering, including its InstaPay/logo transcription.
const observed = `Sent!
PHP 800.00
Service Fee
PHP 0.00
Total Amount
PHP 800.00
Send Money instaFay
via
To
TEST COURT OWNER...7890
From
SA W/ ATM W/O
PASBK-INDIVIDUAL
........5616
Created on
Sep 29, 2026 06:13 PM
Reference no.
BN-20260929-03089999
Invoice no.
488999
BDO 52
Years`;
const context = {
  typedReference: "BN-20260929-03089999",
  expectedAmount: 800,
  pricingAvailable: true,
  amountTolerance: .01,
  expectedRecipientName: "TEST COURT OWNER",
  expectedRecipientNumber: "1234567890",
  bookingStartedAt: "2026-09-29T10:11:49.865Z",
  bookingStartedDate: "2026-09-29",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};
const run = (raw = observed, patch = {}) => {
  const c = { ...context, ...patch },
    p = parseRcbcReceipt(raw, { typedReference: c.typedReference });
  return { p, v: verifyRcbcReceipt(p, c) };
};
Deno.test("BDO RCBC actual OCR layout: principal, recipient, reference and PH time", () => {
  const { p, v } = run();
  eq(v.flags, []);
  eq(p.sourceParserVersion, "bdo_to_rcbc_v1");
  eq(p.amount.amount, 800);
  eq(p.timestamp.instant, "2026-09-29T10:13:00.000Z");
  eq(p.recipient.accountRaw, "...7890");
  eq(v.recipientComparison.name, "exact");
  eq(v.recipientComparison.account, "suffix_exact");
  eq(p.destinationBank, null); // Bank not printed: never pretend it was OCR'd.
  eq(p.canonicalReference, "BN2026092903089999");
  eq(p.invoiceReference, "488999");
  eq(v.dedupeKeys.map((k) => k.key), [
    "rcbc:BN2026092903089999",
    "bdopay:BN2026092903089999",
    "bdopay_invoice:488999",
  ]);
});
Deno.test("BDO conventional rail label, ellipsis, brand and compact reference", () => {
  eq(
    run(
      observed.replace("instaFay\nvia", "via instaPay").replace(
        "...7890",
        "…7890",
      ).replace("BDO 52\nYears", "BDO"),
      { typedReference: "BN2026092903089999" },
    ).v.flags,
    [],
  );
});
Deno.test("BDO fee excluded from booking principal and total reconciled", () => {
  const raw = observed.replace("PHP 0.00", "PHP 10.00").replace(
    "Total Amount\nPHP 800.00",
    "Total Amount\nPHP 810.00",
  );
  eq(run(raw).v.flags, []);
  eq(
    run(raw, { expectedAmount: 810 }).v.flags.includes("AMOUNT_MISMATCH"),
    true,
  );
  eq(
    run(observed.replace("PHP 0.00", "PHP 10.00")).v.flags.includes(
      "BDO_TOTAL_MISMATCH",
    ),
    true,
  );
});
for (
  const [title, raw, patch, flag] of [
    [
      "wrong recipient name",
      observed.replace("TEST COURT OWNER", "OTHER COURT OWNER"),
      {},
      "RECEIVER_NAME_MISMATCH",
    ],
    [
      "truncated recipient name",
      observed.replace("TEST COURT OWNER", "TEST COURT OWNE"),
      {},
      "RECEIVER_NAME_MISMATCH",
    ],
    [
      "wrong receiving suffix",
      observed.replace("...7890", "...5616"),
      {},
      "RECEIVER_ACCOUNT_MISMATCH",
    ],
    ["sender cannot substitute receiving suffix", observed, {
      expectedRecipientNumber: "1234565616",
    }, "RECEIVER_ACCOUNT_MISMATCH"],
    [
      "missing merchant config",
      observed,
      { expectedRecipientNumber: "" },
      "MERCHANT_CONFIG_MISSING",
    ],
    [
      "wrong booking amount",
      observed,
      { expectedAmount: 600 },
      "AMOUNT_MISMATCH",
    ],
    [
      "unavailable pricing",
      observed,
      { pricingAvailable: false },
      "PRICING_UNAVAILABLE",
    ],
    ["wrong typed reference", observed, {
      typedReference: "BN-20260929-03088888",
    }, "REF_MISMATCH"],
    ["invoice is not transaction reference", observed, {
      typedReference: "488999",
    }, "REF_MISMATCH"],
    [
      "old payment",
      observed,
      { bookingStartedAt: "2026-09-30T10:11:00Z" },
      "TIME_EXPIRED",
    ],
    ["payment outside window", observed, {
      bookingStartedAt: "2026-09-29T09:11:00Z",
    }, "TIME_EXPIRED"],
    [
      "reference date differs",
      observed.replace("BN-20260929", "BN-20260928"),
      {},
      "BDO_REFERENCE_DATE_MISMATCH",
    ],
    [
      "failed status",
      observed.replace("Sent!", "Failed!"),
      {},
      "RCBC_FORMAT_UNSUPPORTED",
    ],
    [
      "pending status appended",
      observed + "\nPending",
      {},
      "RCBC_FORMAT_UNSUPPORTED",
    ],
    [
      "missing BDO logo text",
      observed.replace("BDO 52\nYears", ""),
      {},
      "RCBC_FORMAT_UNSUPPORTED",
    ],
    [
      "contradictory destination",
      observed.replace("To\n", "To\nGCash\n"),
      {},
      "RCBC_FORMAT_UNSUPPORTED",
    ],
    [
      "duplicate recipient field",
      observed.replace("To\n", "To\nOTHER...7890\nTo\n"),
      {},
      "RCBC_FORMAT_UNSUPPORTED",
    ],
    [
      "missing invoice",
      observed.replace("Invoice no.\n488999\n", ""),
      {},
      "RCBC_FORMAT_UNSUPPORTED",
    ],
  ] as const
) {
  Deno.test(`BDO RCBC rejects ${title}`, () =>
    eq(run(raw, patch).v.flags.includes(flag), true));
}
Deno.test("BDO critical digit confidence includes reference, invoice, amount and recipient", () => {
  const { p } = run();
  const words = observed.split(/\s+/).map((text) => ({
    text,
    minDigitConfidence: .99,
  }));
  eq(rcbcCriticalDigitsReadable(words, p), true);
  for (
    const target of ["BN-20260929-03089999", "488999", "800.00", "OWNER...7890"]
  ) {
    eq(
      rcbcCriticalDigitsReadable(
        words.map((w) =>
          w.text === target ? { ...w, minDigitConfidence: .5 } : w
        ),
        p,
      ),
      false,
    );
  }
  eq(rcbcCriticalDigitsReadable([], p), false);
});

import { parseBpiToRcbcReceipt, verifyBpiToRcbcReceipt } from "./bpi-rcbc.ts";
import { rcbcFixtures } from "./rcbc-fixtures.ts";
const fixture = rcbcFixtures[6];
const valid = fixture.text;
const context = {
  typedReference: fixture.typed,
  expectedAmount: 3150,
  pricingAvailable: true,
  amountTolerance: 0,
  expectedRecipientNumber: "1234567890",
  expectedRecipientName: "TEST COURT OWNER",
  bookingStartedAt: fixture.started,
  bookingStartedDate: "2026-09-26",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};
function run(text = valid, patch = {}) {
  const c = { ...context, ...patch };
  const p = parseBpiToRcbcReceipt(text, { typedReference: c.typedReference });
  return { p, v: verifyBpiToRcbcReceipt(p, c) };
}
function eq(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error(JSON.stringify({ actual: a, expected: b }));
  }
}
Deno.test("BPI RCBC dedicated parser accepts both aliases with identical replay keys", () => {
  const a = run(), b = run(valid, { typedReference: "1000000000600" });
  eq(a.p.sourceParserVersion, "bpi_to_rcbc_v1");
  eq(a.v.flags, []);
  eq(b.v.flags, []);
  eq(a.v.dedupeKeys, b.v.dedupeKeys);
});
Deno.test("BPI RCBC accepts three or four masked digits with all other evidence", () => {
  eq(run().v.flags, []);
  eq(run(valid.replace("XXXXX890", "XXXXX7890")).v.flags, []);
  eq(run().v.recipientComparison.account, "suffix_exact");
});
Deno.test("BPI RCBC requires masking and at least three account digits", () => {
  for (const account of ["XXXXXXXXXXXXX90", "890", "XXXXXXXXXXXXX"]) {
    eq(
      run(valid.replace("XXXXXXXXXXXXX890", account)).v.flags.includes(
        "RECEIVER_ACCOUNT_UNREADABLE",
      ),
      true,
    );
  }
});
for (
  const [label, text, flag] of [
    [
      "wrong account",
      valid.replace("XXXXX890", "XXXXX891"),
      "RECEIVER_ACCOUNT_MISMATCH",
    ],
    [
      "wrong name",
      valid.replace("TEST COURT OWNER", "OTHER PERSON"),
      "RECEIVER_NAME_MISMATCH",
    ],
    [
      "wrong bank",
      valid.replace("RCBC/DiskarTech", "GCash"),
      "RCBC_DESTINATION_MISMATCH",
    ],
    ["wrong amount", valid.replace("3,150.00", "3,149.00"), "AMOUNT_MISMATCH"],
    [
      "failed status",
      valid.replace("Transfer successful!", "Transfer failed!"),
      "TRANSFER_STATUS_UNREADABLE",
    ],
    [
      "duplicate reference",
      valid + "\nConfirmation No. 1000000000601",
      "REF_UNREADABLE",
    ],
    ["missing reference", valid.replace("100006", ""), "REF_UNREADABLE"],
  ] as const
) {
  Deno.test("BPI RCBC blocks " + label, () => {
    const flags = run(text).v.flags;
    if (!flags.includes(flag)) throw Error(JSON.stringify(flags));
  });
}
Deno.test("BPI RCBC bank fee is excluded from booking payment", () => {
  eq(run(valid.replace("PHP 0.00", "PHP 25.00")).v.flags, []);
});
for (
  const [start, passes] of [
    ["2026-09-26T04:31:00Z", true],
    ["2026-09-26T04:30:00Z", false],
    ["2026-09-26T04:48:00Z", true],
    ["2026-09-26T04:49:00Z", false],
  ] as const
) {
  Deno.test("BPI RCBC original time window " + start, () => {
    eq(
      run(valid, { bookingStartedAt: start }).v.flags.includes("TIME_EXPIRED"),
      !passes,
    );
  });
}
Deno.test("BPI RCBC missing receipt time cannot borrow the screenshot clock", () => {
  const text = valid.replace(/Saturday[^\n]+/, "");
  eq(run(text).v.flags.includes("TIME_UNREADABLE"), true);
});

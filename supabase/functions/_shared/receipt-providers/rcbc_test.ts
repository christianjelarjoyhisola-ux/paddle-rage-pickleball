import {
  parseRcbcReceipt,
  rcbcCriticalDigitsReadable,
  verifyRcbcReceipt,
} from "./rcbc.ts";
import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";
import { rcbcFixtures } from "./rcbc-fixtures.ts";
const eq = (a: unknown, b: unknown) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw Error(JSON.stringify({ actual: a, expected: b }));
  }
};
const context = (i: number) => ({
  typedReference: rcbcFixtures[i].typed,
  expectedAmount: rcbcFixtures[i].amount,
  pricingAvailable: true,
  amountTolerance: .01,
  expectedRecipientNumber: "1234567890",
  expectedRecipientName: "TEST COURT OWNER",
  bookingStartedAt: rcbcFixtures[i].started,
  bookingStartedDate: rcbcFixtures[i].started.slice(0, 10),
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
});
const run = (i: number, text = rcbcFixtures[i].text, patch = {}) => {
  const c = { ...context(i), ...patch };
  const p = parseRcbcReceipt(text, { typedReference: c.typedReference });
  return { p, v: verifyRcbcReceipt(p, c) };
};
Deno.test("GCash row-order bank receipt excludes the transfer fee", () => {
  const text = `Bank Transfer Complete
Sent via GCash
Bank
RCBC/DiskarTech
Account No.
********7890
Account Name
TEST COURT OWNER
Transfer Method
InstaPay
Receipt sent to
test@example.invalid
Transfer Amount
1,400.00
+Fee
10.00
Total
P 1,410.00
Date
Sep 25, 2026 09:40 PM
InstaPay Invoice No.
12345678
Ref No.
9876543212345`;
  const c = {
    ...context(1),
    typedReference: "9876543212345",
    expectedAmount: 1400,
    bookingStartedAt: "2026-09-25T13:38:00Z",
  };
  const p = parseRcbcReceipt(text, { typedReference: c.typedReference });
  eq(p.amount.amount, 1400);
  eq(verifyRcbcReceipt(p, c).flags, []);
});
for (const [i, f] of rcbcFixtures.entries()) {
  Deno.test(`RCBC observed layout ${i + 1} preserves its expected decision`, () => {
    const { p, v } = run(i);
    for (const flag of f.flags) {
      if (!v.flags.includes(flag)) {
        throw Error(flag + " missing " + JSON.stringify(v.flags));
      }
    }
    if (!f.flags.length) eq(v.flags, []);
    eq(p.destinationProvider, "rcbc");
  });
}
Deno.test("GCash transfer amount excludes bank fee and is labelled evidence", () => {
  eq(run(1).p.amount.amount, 350);
  eq(run(1, rcbcFixtures[1].text, { expectedAmount: 360 }).v.flags, [
    "AMOUNT_MISMATCH",
  ]);
});
Deno.test("MariBank day-first 24-hour transaction date is parsed in Manila", () => {
  eq(run(2).p.timestamp.instant, "2026-09-25T13:55:00.000Z");
});
Deno.test("BPI accepts either observed identifier but does not invent one", () => {
  const text = rcbcFixtures[6].text.replace("XXXXX890", "XXXXX7890");
  const first = run(6, text);
  eq(first.v.flags, []);
  const canonical = first.p.canonicalReference!;
  const second = run(6, text, { typedReference: canonical });
  eq(second.v.flags, []);
  eq(first.v.dedupeKeys, second.v.dedupeKeys);
  if (
    !run(6, text, { typedReference: "999999" }).v.flags.includes("REF_MISMATCH")
  ) throw Error("Invented reference");
});
for (const i of [0, 1, 2]) {
  Deno.test(`RCBC layout ${i} rejects wrong recipient name`, () => {
    if (
      !run(i, rcbcFixtures[i].text, { expectedRecipientName: "OTHER OWNER" }).v
        .flags.includes("RECEIVER_NAME_MISMATCH")
    ) throw Error("name bypass");
  });
  Deno.test(`RCBC layout ${i} rejects wrong account`, () => {
    if (
      !run(i, rcbcFixtures[i].text, { expectedRecipientNumber: "1234567891" }).v
        .flags.includes("RECEIVER_ACCOUNT_MISMATCH")
    ) throw Error("account bypass");
  });
  Deno.test(`RCBC layout ${i} rejects incorrect bank`, () => {
    if (
      !run(i, rcbcFixtures[i].text.replaceAll("RCBC", "OTHERBANK")).v.flags
        .length
    ) throw Error("bank bypass");
  });
  Deno.test(`RCBC layout ${i} rejects contradictory transaction status`, () => {
    if (
      !run(i, rcbcFixtures[i].text + "\nFailed").v.flags.includes(
        "TRANSFER_STATUS_UNREADABLE",
      )
    ) throw Error("status bypass");
  });
  Deno.test(`RCBC layout ${i} rejects stale payments`, () => {
    if (
      !run(i, rcbcFixtures[i].text, {
        bookingStartedAt: "2026-09-24T00:00:00Z",
      }).v.flags.includes("TIME_EXPIRED")
    ) throw Error("time bypass");
  });
  Deno.test(`RCBC layout ${i} requires authoritative amount`, () => {
    if (
      !run(i, rcbcFixtures[i].text, { pricingAvailable: false }).v.flags
        .includes("PRICING_UNAVAILABLE")
    ) throw Error("pricing bypass");
  });
}
Deno.test("BPI three masked digits satisfy its dedicated account policy", () => {
  eq(run(6).v.flags, []);
});
Deno.test("Incomplete screenshots cannot borrow the phone clock as payment time", () => {
  eq(run(3).p.timestamp.instant, null);
  eq(run(4).p.timestamp.instant, null);
});
Deno.test("Unknown documents never produce clean RCBC evidence", () => {
  if (
    !run(0, "RCBC 1234567890 TEST COURT OWNER PHP 3600.00").v.flags.includes(
      "RCBC_FORMAT_UNSUPPORTED",
    )
  ) throw Error("unsupported bypass");
});
Deno.test("RCBC dispatch retains its own destination", () => {
  const p = parseProviderReceipt("rcbc", rcbcFixtures[1].text, {
    typedReference: context(1).typedReference,
  });
  eq(p.destinationProvider, "rcbc");
  eq(verifyProviderReceipt(p, context(1)).flags, []);
});
Deno.test("Transfer fee arithmetic must agree with total debit", () => {
  if (
    !run(1, rcbcFixtures[1].text.replace("P 360.00", "P 361.00")).v.flags
      .includes("AMOUNT_CONFLICT")
  ) throw Error("fee mismatch bypass");
});
Deno.test("Duplicate reference labels are ambiguous", () => {
  if (
    !run(0, rcbcFixtures[0].text + "\nInstapay Reference Number\n123456").v
      .flags.includes("REF_UNREADABLE")
  ) throw Error("duplicate label bypass");
});
Deno.test("Unrelated sending-app brand cannot select another RCBC format", () => {
  if (
    !run(1, rcbcFixtures[1].text + "\nSent via BPI\nTransfer successful!").v
      .flags.includes("RCBC_FORMAT_UNSUPPORTED")
  ) throw Error("ambiguous layout bypass");
});
Deno.test("A changed reference changes replay identity; changing BPI alias does not", () => {
  const a = run(0).v.dedupeKeys,
    b =
      run(0, rcbcFixtures[0].text.replaceAll(rcbcFixtures[0].typed, "987654"), {
        typedReference: "987654",
      }).v.dedupeKeys;
  if (JSON.stringify(a) === JSON.stringify(b)) throw Error("identity omitted");
});
Deno.test("RCBC critical digits require native confidence on reference, account and amount", () => {
  const p = run(0).p;
  const values = [
    ...p.references,
    p.recipient.accountRaw!,
    p.amount.amount!.toFixed(2),
  ];
  const words = values.map((text) => ({ text, minDigitConfidence: .99 }));
  eq(rcbcCriticalDigitsReadable(words, p), true);
  for (let i = 0; i < words.length; i++) {
    eq(
      rcbcCriticalDigitsReadable(
        words.map((w, j) => ({
          ...w,
          minDigitConfidence: i === j ? .89 : .99,
        })),
        p,
      ),
      false,
    );
  }
  eq(rcbcCriticalDigitsReadable([], p), false);
  eq(rcbcCriticalDigitsReadable(words.slice(1), p), false);
});
Deno.test("RCBC critical amount digits support OCR punctuation tokens", () => {
  const p = run(0).p;
  const words = [
    ...p.references,
    p.recipient.accountRaw!,
    "₱",
    "3",
    ",",
    "600",
    ".",
    "00",
  ].map((text) => ({ text, minDigitConfidence: .99 }));
  eq(rcbcCriticalDigitsReadable(words, p), true);
});

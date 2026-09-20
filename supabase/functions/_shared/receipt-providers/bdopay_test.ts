import {
  parseBdoPayToGcashReceipt,
  verifyBdoPayToGcashReceipt,
} from "./bdopay.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const RECEIPT = `
Sent!
PHP 1,600.00
Sep 02, 2026 07:07 PM
Amount
PHP 1,600.00
Service Fee
PHP 0.00
Send Money via InstaPay
To
PaddleRage
G-XCHANGE, INC. / GCASH
DWQM4TK3JDO9O0NS8
From
Meriam Plaza
•••• •••• 5751
Invoice number
961119
Reference no.
BN-20260902-69811640
`;

const CONTEXT = {
  typedReference: "BN2026090269811640",
  expectedAmount: 1600,
  pricingAvailable: true,
  amountTolerance: 0.01,
  expectedRecipientName: "PaddleRage",
  expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
  bookingStartedAt: "2026-09-02T11:05:00.000Z",
  bookingStartedDate: "2026-09-02",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};

const COMPACT_RECEIPT = `
Change in Send Money status
Hello! Your Send Money worth PHP 9,999.00 to PaddleRage was successful.
Sent!
PHP 3,200.00
Service Fee
PHP 0.00
Total Amount
PHP 3,200.00
Send Money via
To
PaddleRage...0NS8
From
REGULAR SA-INDIVIDUAL
••••••••2615
Created on
Sep 11, 2026 04:17 PM
Reference no.
BN-20260911-80487993
Invoice no.
367094
BDO 50 Years
Save Image Share
`;

const COMPACT_CONTEXT = {
  ...CONTEXT,
  typedReference: "BN2026091180487993",
  expectedAmount: 3200,
  expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
  bookingStartedAt: "2026-09-11T08:16:00.000Z",
  bookingStartedDate: "2026-09-11",
};

const REORDERED_RECEIPT = COMPACT_RECEIPT
  .replaceAll("3,200.00", "2,000.00")
  .replace("Send Money via\nTo\nPaddleRage...0NS8\nFrom", "Send Money\ninstaFay\nvia\nTo\nFrom\nPaddleRage...ONS8")
  .replace("Sep 11, 2026 04:17 PM", "Sep 20, 2026 09:49 PM")
  .replace("BN-20260911-80487993", "BN-20260920-92375558")
  .replace("367094", "361314");
const REORDERED_CONTEXT = {
  ...COMPACT_CONTEXT,
  expectedAmount: 2000,
  typedReference: "BN2026092092375558",
  bookingStartedAt: "2026-09-20T13:47:33.333Z",
  bookingStartedDate: "2026-09-20",
};

Deno.test("BDO September 20 OCR label ordering and O/0 suffix are verified together", () => {
  const parsed = parseBdoPayToGcashReceipt(REORDERED_RECEIPT, {
    typedReference: REORDERED_CONTEXT.typedReference,
  });
  const result = verifyBdoPayToGcashReceipt(parsed, REORDERED_CONTEXT);
  assert(result.flags.length === 0, JSON.stringify(result.flags));
  assert(parsed.recipient.accountNormalized === "ONS8", "preserve raw OCR suffix");
  assert(result.recipientComparison.account === "suffix_ocr_compatible", "honest OCR evidence");
});

Deno.test("BDO reordered suffix recovery cannot waive identity or structural checks", () => {
  for (const [before, after] of [
    ["PaddleRage...ONS8", "Other Merchant...ONS8"],
    ["PaddleRage...ONS8", "PaddleRage...ON58"],
    ["REGULAR SA-INDIVIDUAL", "PaddleRage...0NS8"],
    ["From\nPaddleRage", "From Someone\nPaddleRage"],
    ["To\nFrom", "From"],
    ["Sent!", "Pending"],
    ["Invoice no.\n361314", ""],
    ["Send Money", "Transfer"],
  ]) {
    assert(flagsFor(REORDERED_RECEIPT.replaceAll(before, after), REORDERED_CONTEXT).length > 0,
      `must review ${before}`);
  }
  for (const context of [
    { expectedAmount: 3000 },
    { typedReference: "BN2026092092375559" },
    { bookingStartedAt: "2026-09-20T12:00:00.000Z" },
    { expectedRecipientAccount: "DWQM4TK3JDO9O9NS8" },
  ]) {
    assert(flagsFor(REORDERED_RECEIPT, { ...REORDERED_CONTEXT, ...context }).length > 0,
      "context mismatch must review");
  }
});

function flagsFor(
  receipt: string,
  context: Partial<typeof CONTEXT> = {},
): string[] {
  const merged = { ...CONTEXT, ...context };
  return verifyBdoPayToGcashReceipt(
    parseBdoPayToGcashReceipt(receipt, {
      typedReference: merged.typedReference,
    }),
    merged,
  ).flags;
}

function assertFlag(
  receipt: string,
  flag: string,
  context: Partial<typeof CONTEXT> = {},
): void {
  const flags = flagsFor(receipt, context);
  assert(flags.includes(flag), `${flag} missing from ${JSON.stringify(flags)}`);
}

Deno.test("BDO Pay parser verifies the supplied live receipt layout", () => {
  const parsed = parseBdoPayToGcashReceipt(RECEIPT, {
    typedReference: CONTEXT.typedReference,
  });
  const evidence = verifyBdoPayToGcashReceipt(parsed, CONTEXT);
  assert(parsed.reference.value === "BN2026090269811640", "BN reference");
  assert(parsed.reference.receiptDate === "2026-09-02", "BN date");
  assert(parsed.invoice.value === "961119", "invoice");
  assert(parsed.amount.amount === 1600, "principal amount");
  assert(
    parsed.timestamp.instant === "2026-09-02T11:07:00.000Z",
    `Manila timestamp: ${parsed.timestamp.instant}`,
  );
  assert(parsed.recipient.nameNormalized === "PADDLERAGE", "recipient name");
  assert(
    parsed.recipient.accountNormalized === "DWQM4TK3JDO9O0NS8",
    "destination token",
  );
  assert(evidence.flags.length === 0, JSON.stringify(evidence.flags));
  assert(
    evidence.dedupeKeys.some((item) =>
      item.key === "bdopay:BN2026090269811640"
    ),
    "BN replay key",
  );
  assert(
    evidence.dedupeKeys.some((item) => item.key === "bdopay_invoice:961119"),
    "invoice replay key",
  );
});

Deno.test("BDO Pay verifies the compact masked-recipient receipt body", () => {
  const parsed = parseBdoPayToGcashReceipt(COMPACT_RECEIPT, {
    typedReference: COMPACT_CONTEXT.typedReference,
  });
  const evidence = verifyBdoPayToGcashReceipt(parsed, COMPACT_CONTEXT);
  assert(parsed.amount.amount === 3200, "banner amount must be ignored");
  assert(
    parsed.amount.candidates.every((item) => item.amount !== 9999),
    "banner excluded",
  );
  assert(parsed.recipient.nameNormalized === "PADDLERAGE", "masked alias");
  assert(parsed.recipient.accountNormalized === "0NS8", "masked suffix");
  assert(parsed.recipient.accountMasked, "masked account marker");
  assert(
    evidence.recipientComparison.account === "suffix_exact",
    "configured token suffix",
  );
  assert(evidence.flags.length === 0, JSON.stringify(evidence.flags));
  assert(
    flagsFor(COMPACT_RECEIPT.replace("Sent!", "Sent"), COMPACT_CONTEXT)
      .length === 0,
    "OCR may omit the Sent punctuation without exposing banner evidence",
  );
});

Deno.test("BDO Pay notification banner cannot supply receipt evidence", () => {
  const withoutBodyLabel = COMPACT_RECEIPT.replace("Send Money via\n", "");
  assertFlag(withoutBodyLabel, "TRANSFER_STATUS_UNREADABLE", COMPACT_CONTEXT);

  const wrongRecipient = COMPACT_RECEIPT.replace(
    "PaddleRage...0NS8\nFrom",
    "Other Merchant...0NS8\nFrom",
  );
  assertFlag(wrongRecipient, "RECEIVER_NAME_MISMATCH", COMPACT_CONTEXT);

  const withoutBodyAnchor = COMPACT_RECEIPT.replace("Sent!\n", "");
  assertFlag(withoutBodyAnchor, "REF_UNREADABLE", COMPACT_CONTEXT);
  assertFlag(withoutBodyAnchor, "TRANSFER_STATUS_UNREADABLE", COMPACT_CONTEXT);
});

Deno.test("BDO Pay compact inference fails closed on identity or structure", () => {
  assertFlag(
    COMPACT_RECEIPT.replace("Sent!", "Sent!\nPending"),
    "TRANSFER_STATUS_UNREADABLE",
    COMPACT_CONTEXT,
  );

  const wrongSuffix = COMPACT_RECEIPT.replace("0NS8\nFrom", "9ZZ9\nFrom");
  assertFlag(wrongSuffix, "RECEIVER_ACCOUNT_MISMATCH", COMPACT_CONTEXT);
  assertFlag(wrongSuffix, "GXI_DESTINATION_UNREADABLE", COMPACT_CONTEXT);
  assertFlag(wrongSuffix, "INSTAPAY_QRPH_UNREADABLE", COMPACT_CONTEXT);

  const missingInvoice = COMPACT_RECEIPT.replace("Invoice no.\n367094\n", "");
  assertFlag(missingInvoice, "INVOICE_UNREADABLE", COMPACT_CONTEXT);
  assertFlag(missingInvoice, "INSTAPAY_QRPH_UNREADABLE", COMPACT_CONTEXT);

  const mismatchedReference = {
    ...COMPACT_CONTEXT,
    typedReference: "BN2026091180487999",
  };
  assertFlag(COMPACT_RECEIPT, "REF_MISMATCH", mismatchedReference);
  assertFlag(COMPACT_RECEIPT, "INSTAPAY_QRPH_UNREADABLE", mismatchedReference);
});

Deno.test("BDO Pay typed reference is comparison-only", () => {
  const parsed = parseBdoPayToGcashReceipt(RECEIPT, {
    typedReference: "BN2026090269811699",
  });
  assert(
    parsed.reference.value === "BN2026090269811640",
    "OCR reference must remain independent",
  );
  assertFlag(RECEIPT, "REF_MISMATCH", {
    typedReference: "BN2026090269811699",
  });
  assertFlag(
    RECEIPT.replace("Reference no.\nBN-20260902-69811640", ""),
    "REF_UNREADABLE",
  );
});

Deno.test("BDO Pay requires two concordant principal amount displays", () => {
  assert(flagsFor(RECEIPT).length === 0, "service fee must be excluded");
  assertFlag(
    RECEIPT.replace("Sent!\nPHP 1,600.00", "Sent!\nPHP 1,500.00"),
    "AMOUNT_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace("Sent!\nPHP 1,600.00\n", "Sent!\n"),
    "AMOUNT_CONFIRMATION_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace(/PHP 1,600\.00/g, "PHP 1,599.00"),
    "AMOUNT_MISMATCH",
  );
});

Deno.test("BDO Pay reference date must corroborate the receipt timestamp", () => {
  assertFlag(
    RECEIPT.replace("BN-20260902-69811640", "BN-20260901-69811640"),
    "REF_DATE_MISMATCH",
    { typedReference: "BN2026090169811640" },
  );
  assertFlag(
    RECEIPT.replace("07:07 PM", "07:21 PM"),
    "TIME_EXPIRED",
  );
  assertFlag(
    RECEIPT.replace("07:07 PM", "07:02 PM"),
    "TIME_FUTURE",
  );
});

Deno.test("BDO Pay requires the exact receipt identity and GCash destination", () => {
  assertFlag(
    RECEIPT.replace("PaddleRage", "Different Merchant"),
    "RECEIVER_NAME_MISMATCH",
  );
  assertFlag(
    RECEIPT.replace("DWQM4TK3JDO9O0NS8", "OTHER1DESTINATION99"),
    "RECEIVER_ACCOUNT_MISMATCH",
  );
  assertFlag(
    RECEIPT.replace("G-XCHANGE, INC. / GCASH", "Different Bank"),
    "GXI_DESTINATION_UNREADABLE",
  );
  assertFlag(RECEIPT, "MERCHANT_CONFIG_MISSING", {
    expectedRecipientName: "",
  });
  assertFlag(RECEIPT, "MERCHANT_CONFIG_MISSING", {
    expectedRecipientAccount: "",
  });
});

Deno.test("BDO Pay requires success, Send Money, InstaPay, and invoice evidence", () => {
  assertFlag(
    RECEIPT.replace("Sent!", "Processing"),
    "TRANSFER_STATUS_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace("Send Money via InstaPay", "Transfer via PESONet"),
    "TRANSFER_STATUS_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace("Send Money via InstaPay", "Send Money via PESONet"),
    "INSTAPAY_QRPH_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace("Invoice number\n961119", ""),
    "INVOICE_UNREADABLE",
  );
  assertFlag(RECEIPT + "\nSent via BPI\n", "METHOD_MISMATCH");
});

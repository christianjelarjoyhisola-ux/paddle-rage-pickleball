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

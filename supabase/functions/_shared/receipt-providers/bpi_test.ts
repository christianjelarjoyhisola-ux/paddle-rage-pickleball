import { parseBpiToGcashReceipt, verifyBpiToGcashReceipt } from "./bpi.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const RECEIPT = `
Transfer successful!
Wednesday, Sep 02, 2026, 07:08:34 AM (GMT +8)
Confirmation No. 1624507073805
Transaction Ref. No. 099408
Sent via BPI
Transfer to
GCash/G-Xchange
PaddleRage (QR Code)
XXXXXXXXXXXXNS8
Transfer amount
PHP 3,600.00
Fee
PHP 0.00
Transfer from
SAVINGS ACCOUNT
XXXXXX6089
Transfer service
InstaPay
`;

const CONTEXT = {
  typedReference: "1624507073805",
  expectedAmount: 3600,
  pricingAvailable: true,
  amountTolerance: 0.01,
  expectedRecipientName: "PaddleRage",
  bookingStartedAt: "2026-09-01T23:06:00.000Z",
  bookingStartedDate: "2026-09-02",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};

function flagsFor(
  receipt: string,
  context: Partial<typeof CONTEXT> = {},
): string[] {
  const merged = { ...CONTEXT, ...context };
  return verifyBpiToGcashReceipt(
    parseBpiToGcashReceipt(receipt, {
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

Deno.test("BPI parser preserves the visible QR account suffix for audit", () => {
  const parsed = parseBpiToGcashReceipt(RECEIPT, {
    typedReference: CONTEXT.typedReference,
  });
  assert(
    parsed.recipient.accountSuffix === "NS8",
    `expected NS8 account suffix, got ${parsed.recipient.accountSuffix}`,
  );
});

Deno.test("BPI verifier fails closed for the wrong recipient or destination", () => {
  assertFlag(
    RECEIPT.replace("PaddleRage (QR Code)", "Different Merchant (QR Code)"),
    "RECEIVER_NAME_MISMATCH",
  );
  assertFlag(
    RECEIPT.replace("GCash/G-Xchange", "Different Bank"),
    "GXI_DESTINATION_UNREADABLE",
  );
  assertFlag(RECEIPT, "MERCHANT_CONFIG_MISSING", {
    expectedRecipientName: "",
  });
});

Deno.test("BPI verifier requires an exact, unambiguous amount and ignores the fee", () => {
  assert(flagsFor(RECEIPT).length === 0, "the PHP 0 fee must not compete");
  assertFlag(
    RECEIPT.replace("PHP 3,600.00", "PHP 3,500.00"),
    "AMOUNT_MISMATCH",
  );
  assertFlag(
    RECEIPT.replace("PHP 3,600.00", "PHP 3,700.00"),
    "AMOUNT_MISMATCH",
  );
  assertFlag(
    RECEIPT.replace(
      "Transfer amount\nPHP 3,600.00",
      "Transfer amount\nPHP 3,500.00\nTotal amount\nPHP 3,600.00",
    ),
    "AMOUNT_UNREADABLE",
  );
});

Deno.test("BPI verifier never substitutes typed reference for missing or conflicting OCR", () => {
  assertFlag(RECEIPT, "REF_MISMATCH", {
    typedReference: "1624507073999",
  });
  assertFlag(
    RECEIPT.replace("Confirmation No. 1624507073805\n", ""),
    "BPI_CONFIRMATION_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace(
      "Confirmation No. 1624507073805",
      "Confirmation No. 1624507073805\nConfirmation No. 1624507073999",
    ),
    "BPI_CONFIRMATION_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace("Transaction Ref. No. 099408\n", ""),
    "BPI_TRANSACTION_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace(
      "Transaction Ref. No. 099408",
      "Transaction Ref. No. 099408\nTransaction Ref. No. 099409",
    ),
    "BPI_TRANSACTION_UNREADABLE",
  );
});

Deno.test("BPI verifier rejects stale, premature, and wrong-date evidence", () => {
  assertFlag(
    RECEIPT.replace("07:08:34 AM", "07:30:34 AM"),
    "TIME_EXPIRED",
  );
  assertFlag(
    RECEIPT.replace("07:08:34 AM", "07:00:34 AM"),
    "TIME_FUTURE",
  );
  assertFlag(
    RECEIPT.replace("Sep 02, 2026", "Sep 01, 2026"),
    "DATE_NOT_TODAY",
  );
});

Deno.test("BPI verifier requires successful BPI and InstaPay evidence only", () => {
  assertFlag(
    RECEIPT.replace("Transfer successful!", "Transfer processing"),
    "TRANSFER_STATUS_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace("Sent via BPI", "Sent via Maya"),
    "BPI_UNREADABLE",
  );
  assertFlag(RECEIPT + "\nSent via Maya\n", "METHOD_MISMATCH");
  assertFlag(
    RECEIPT.replace("InstaPay", "PESONet"),
    "INSTAPAY_QRPH_UNREADABLE",
  );
  assertFlag(RECEIPT.replace("(GMT +8)", ""), "TIMEZONE_UNREADABLE");
});

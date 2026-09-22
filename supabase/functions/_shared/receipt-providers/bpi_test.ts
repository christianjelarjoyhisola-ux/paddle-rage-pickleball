import {
  configuredBpiMobileAliases,
  parseBpiToGcashReceipt,
  verifyBpiToGcashReceipt,
} from "./bpi.ts";
import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("BPI approved names are scoped to the configured full receiving number", () => {
  const config = '{"09455107667":["JKEM","Paddle Rage"]}';
  assert(
    configuredBpiMobileAliases(config, "09455107667").length === 2,
    "approved labels",
  );
  assert(
    configuredBpiMobileAliases(config, "+63 945 510 7667").length === 2,
    "normalized same number",
  );
  for (const number of ["09455107668", "", "7667"]) {
    assert(
      configuredBpiMobileAliases(config, number).length === 0,
      "cannot authorize a different number",
    );
  }
  assert(
    configuredBpiMobileAliases("invalid json", "09455107667").length === 0,
    "invalid config fails closed",
  );
});

// Same OCR layout as the reported direct-to-mobile receipt, including the
// visible sender section and no QR/transfer-service marker.
const MOBILE_RECEIPT = `18:10
Ill 5G
Transfer successful!
Tuesday, Sep 22 2026; 06:09:53 PM (GMT +8)
Confirmation No. 1626518942470
Transaction Ref. No. 086535
Sent via BPI
Transfer to
GCash/G-Xchange
paddle rage
09455107667
Add to Favorites
Transfer amount
PHP 800.00
Fee
PHP 0.00
^ Hide other details
Transfer from
SAVINGS ACCOUNT
XXXXXX8945 O
New transfer
Go to Accounts`;

const MOBILE_CONTEXT = {
  typedReference: "1626518942470",
  expectedAmount: 800,
  pricingAvailable: true,
  amountTolerance: 0.01,
  expectedRecipientName: "PaddleRage",
  expectedRecipientNumber: "09455107667",
  expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
  bookingStartedAt: "2026-09-22T10:07:38.068Z",
  bookingStartedDate: "2026-09-22",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};

Deno.test("BPI configured mobile aliases require the exact full recipient number", () => {
  const receipt = MOBILE_RECEIPT.replace("paddle rage", "JKEM");
  const parse = (text: string) =>
    parseBpiToGcashReceipt(text, {
      typedReference: MOBILE_CONTEXT.typedReference,
    });
  const context = { ...MOBILE_CONTEXT, expectedRecipientNameAliases: ["JKEM"] };
  assert(
    verifyBpiToGcashReceipt(parse(receipt), context).flags.length === 0,
    "explicit alias matches",
  );
  assert(
    verifyBpiToGcashReceipt(parse(receipt), MOBILE_CONTEXT).flags.includes(
      "RECEIVER_NAME_MISMATCH",
    ),
    "unknown names need review",
  );
  assert(
    verifyBpiToGcashReceipt(
      parse(receipt.replace("09455107667", "09455107668")),
      context,
    ).flags.includes("RECEIVER_ACCOUNT_MISMATCH"),
    "alias cannot authorize another number",
  );
  assert(
    verifyBpiToGcashReceipt(
      parse(receipt.replace("09455107667", "XXXXXX7667")),
      context,
    ).flags.includes("RECEIVER_NAME_MISMATCH"),
    "alias cannot authorize masked destinations",
  );
});

Deno.test("BPI direct-to-mobile receipt passes through the production provider dispatcher", () => {
  const parsed = parseProviderReceipt("bpi", MOBILE_RECEIPT, {
    typedReference: MOBILE_CONTEXT.typedReference,
  });
  const evidence = verifyProviderReceipt(parsed, MOBILE_CONTEXT);
  assert(evidence.flags.length === 0, JSON.stringify(evidence.flags));
  assert(
    evidence.provider === "bpi" &&
      evidence.recipientAccountComparison === "exact",
    "full number matches",
  );
  assert(
    evidence.dedupeKeys.some((key) => key.key === "bpi:1626518942470"),
    "confirmation replay key preserved",
  );
  assert(
    evidence.dedupeKeys.some((key) => key.key === "bpi_transaction:086535"),
    "transaction replay key preserved",
  );
});

Deno.test("BPI mobile layout still rejects the reported truncated confirmation number", () => {
  const parsed = parseBpiToGcashReceipt(MOBILE_RECEIPT, {
    typedReference: "1626518942",
  });
  const evidence = verifyBpiToGcashReceipt(parsed, MOBILE_CONTEXT);
  assert(
    JSON.stringify(evidence.flags) === JSON.stringify(["REF_MISMATCH"]),
    JSON.stringify(evidence.flags),
  );
});

Deno.test("BPI mobile recipient accepts exact national or international numbers only", () => {
  for (const phone of ["09455107667", "+63 945 510 7667"]) {
    const parsed = parseBpiToGcashReceipt(
      MOBILE_RECEIPT.replace("09455107667", phone),
      { typedReference: MOBILE_CONTEXT.typedReference },
    );
    assert(
      parsed.recipient.accountNumber === "09455107667",
      "normalized recipient",
    );
    assert(
      verifyBpiToGcashReceipt(parsed, MOBILE_CONTEXT).flags.length === 0,
      "valid full number",
    );
  }
  for (
    const [receipt, patch, flag] of [
      [
        MOBILE_RECEIPT.replace("09455107667", "09455107668"),
        {},
        "RECEIVER_ACCOUNT_MISMATCH",
      ],
      [
        MOBILE_RECEIPT,
        { expectedRecipientNumber: "" },
        "MERCHANT_CONFIG_MISSING",
      ],
      [
        MOBILE_RECEIPT.replace("09455107667", "7667"),
        {},
        "RECEIVER_ACCOUNT_UNREADABLE",
      ],
      [
        MOBILE_RECEIPT.replace("09455107667", "09455107667\n09455107668"),
        {},
        "RECEIVER_ACCOUNT_UNREADABLE",
      ],
      [
        MOBILE_RECEIPT.replace("09455107667", "").replace(
          "XXXXXX8945 O",
          "09455107667",
        ),
        {},
        "RECEIVER_ACCOUNT_UNREADABLE",
      ],
      [
        MOBILE_RECEIPT.replace("paddle rage", "Different recipient"),
        {},
        "RECEIVER_NAME_MISMATCH",
      ],
      [
        MOBILE_RECEIPT.replace("GCash/G-Xchange", "Different Bank"),
        {},
        "GXI_DESTINATION_UNREADABLE",
      ],
      [
        MOBILE_RECEIPT.replace("PHP 800.00", "PHP 700.00"),
        {},
        "AMOUNT_MISMATCH",
      ],
      [
        MOBILE_RECEIPT.replace("Transfer successful!", "Transfer processing"),
        {},
        "TRANSFER_STATUS_UNREADABLE",
      ],
      [
        MOBILE_RECEIPT.replace("06:09:53 PM", "06:39:53 PM"),
        {},
        "TIME_EXPIRED",
      ],
    ] as const
  ) {
    const parsed = parseBpiToGcashReceipt(receipt, {
      typedReference: MOBILE_CONTEXT.typedReference,
    });
    const flags =
      verifyBpiToGcashReceipt(parsed, { ...MOBILE_CONTEXT, ...patch }).flags;
    assert(flags.includes(flag), `${flag} expected: ${JSON.stringify(flags)}`);
  }
});

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
  expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
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
  const evidence = verifyBpiToGcashReceipt(parsed, CONTEXT);
  assert(
    evidence.recipientAccountComparison === "exact",
    `expected exact destination, got ${evidence.recipientAccountComparison}`,
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
  assertFlag(
    RECEIPT.replace("XXXXXXXXXXXXNS8", "XXXXXXXXXXXXBAD"),
    "RECEIVER_ACCOUNT_MISMATCH",
  );
  assertFlag(RECEIPT, "MERCHANT_CONFIG_MISSING", {
    expectedRecipientAccount: "",
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

Deno.test("BPI September receipt accepts semicolon date separator and preserves seconds", () => {
  const receipt = RECEIPT
    .replace(
      "Wednesday, Sep 02, 2026, 07:08:34 AM",
      "Saturday, Sep 19 2026; 12:48:47 PM",
    )
    .replace("1624507073805", "1626212570530")
    .replace("099408", "480849")
    .replace("3,600.00", "1,600.00");
  const context = {
    ...CONTEXT,
    typedReference: "1626212570530",
    expectedAmount: 1600,
    bookingStartedAt: "2026-09-19T04:46:00.000Z",
    bookingStartedDate: "2026-09-19",
  };
  const parsed = parseBpiToGcashReceipt(receipt, {
    typedReference: context.typedReference,
  });
  assert(
    parsed.timestamp.instant === "2026-09-19T04:48:47.000Z",
    "correct noon timestamp including seconds",
  );
  assert(
    flagsFor(receipt, context).length === 0,
    "reported receipt passes evidence checks",
  );
  for (
    const invalid of [
      "Sep 31 2026; 12:48:47 PM",
      "Sep 19 2026; 13:48:47 PM",
      "Sep 19 2026; 12:60:47 PM",
      "Sep 19 2026; 12:48:99 PM",
    ]
  ) {
    assertFlag(
      receipt.replace("Sep 19 2026; 12:48:47 PM", invalid),
      "TIME_UNREADABLE",
      context,
    );
  }
  assertFlag(
    receipt.replace("12:48:47 PM", "01:05:47 PM"),
    "TIME_EXPIRED",
    context,
  );
  assertFlag(
    receipt.replace("Sep 19 2026;", "Sep 18 2026;"),
    "DATE_NOT_TODAY",
    context,
  );
  assertFlag(receipt.replace("(GMT +8)", ""), "TIMEZONE_UNREADABLE", context);
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

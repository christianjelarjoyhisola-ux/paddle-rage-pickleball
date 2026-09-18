import {
  parseProviderReceipt,
  UnsupportedReceiptProviderError,
  verifyProviderReceipt,
} from "./index.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const CONTEXT = {
  expectedAmount: 1080,
  pricingAvailable: true,
  amountTolerance: 0.01,
  expectedRecipientNumber: "09455107667",
  expectedRecipientName: "Paddle Rage Pickleball",
  bookingStartedAt: "2026-08-31T02:40:00.000Z",
  bookingStartedDate: "2026-08-31",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};

const GOTYME_OCR = `
GoTyme Bank
Transfer successful
To
Paddle Rage Pickleball
GCash / G-Xchange
Mobile number 0945 510 7667
Amount PHP 1,080.00
Transaction ID GTY2026083112345678
InstaPay Ref No 987654321234
Aug 31, 2026 10:41 AM
InstaPay
`;

const GOTYME_LIVE_OCR = `
GoTyme Bank
Sent
₱3,600.00
instaPay
Instant
To
Paddle Rage
0••••••7667
G-Xchange, Inc (GCash)
From
J. ARCADIO
••••••••4792
GoTyme Bank
Amount
₱3,600.00
Fee
₱0.00
Total
₱3,600.00
Trace ID
000018
Reference No.
ITO260910112033018
Date
10 Sep 2026 at 7:20 PM
`;

const GOTYME_REPORTED_24H_OCR = `
GoTyme Bank
Sent
₱2,200.00
instaPay
Instant
To
J M.
0······7667
G-Xchange, Inc (GCash)
From
R. VITOR
••••••••3022
GoTyme Bank
Amount
₱2,200.00
Fee
₱0.00
Total
₱2,200.00
Trace ID
OCR spacer
000001
Reference No.
OCR spacer
ITO260911114957001
Date
11 Sep 2026 at 19:49
`;

const MARIBANK_OCR = `
MariBank
Money sent
Recipient
Paddle Rage Pickleball
GCash
Account number 0945-510-7667
Amount PHP 1,080.00
Reference No MB2026083198765432
InstaPay Reference No 987654321234
2026-08-31 10:42 AM
via InstaPay
`;

const MARIBANK_TRANSACTION_RECEIPT_OCR = `
From
To
Transfer Amount
Transfer Fee
Total Amount
Reference Number
Transfer Method
Processing Time
M MariBank
Transaction Receipt
PHP 800.00
Transaction Date & Time
• ALTHEA MIDGE E.
MariBank: *******5730
Paddlerage
G-Xchange / GCash
Acct No.: DWQM4TK3JDO900NS8
PHP 800.00
FREE
PHP 800.00
664744
instaPay
Realtime
19 Sep 2026, 00:12
Receipt generated from MariBank app
`;

const GCASH_OCR = `
PADDLE RAGE PICKLEBALL
+63 945 510 7667
Sent via GCash
Amount
1,080.00
Total Amount Sent
₱1,080.00
Ref No. 2043350406766 Aug 31, 2026 10:41 AM
`;

const REORDERED_GCASH_OCR = `
1:01 1
Amount
Express Send
J.. KE...HM.
+63 9..
Total Amount Sent
7667
Sent via GCash
3,600.00
P3600.00
Ref No. 5045095386043
Sep 16, 2026 1:00 AM
279g (gCO2e)
By going digital, you reduce your carbon footprint.
`;

const BPI_OCR = `
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

const BDOPAY_OCR = `
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

Deno.test("dispatches clean dedicated BDO Pay evidence", () => {
  const typedReference = "BN2026090269811640";
  const parsed = parseProviderReceipt("bdopay", BDOPAY_OCR, { typedReference });
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 1600,
    expectedRecipientName: "PaddleRage",
    expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
    bookingStartedAt: "2026-09-02T11:05:00.000Z",
    bookingStartedDate: "2026-09-02",
  });
  assert(parsed.provider === "bdopay", "BDO Pay provider");
  assertEquals(parsed.provider, "bdopay", "BDO Pay provider");
  assertEquals(
    parsed.parserVersion,
    "bdopay_to_gcash_v1",
    "BDO Pay parser version",
  );
  assertEquals(parsed.receipt.invoice.value, "961119", "BDO Pay invoice");
  assertEquals(verified.flags, [], "clean BDO Pay flags");
});

Deno.test("dispatches clean GCash, GoTyme-to-GCash, and MariBank-to-GCash evidence", () => {
  const cases = [
    ["gcash", GCASH_OCR, "2043350406766", "gcash_v1"],
    ["gotyme", GOTYME_OCR, "GTY2026083112345678", "gotyme_to_gcash_v1"],
    [
      "maribank",
      MARIBANK_OCR,
      "MB2026083198765432",
      "maribank_to_gcash_v1",
    ],
  ] as const;

  for (const [provider, ocr, typedReference, parserVersion] of cases) {
    const parsed = parseProviderReceipt(provider, ocr, { typedReference });
    const verified = verifyProviderReceipt(parsed, {
      ...CONTEXT,
      typedReference,
    });
    assertEquals(parsed.provider, provider, `${provider} provider`);
    assertEquals(
      parsed.destinationProvider,
      "gcash",
      `${provider} destination`,
    );
    assertEquals(
      parsed.parserVersion,
      parserVersion,
      `${provider} parser version`,
    );
    assertEquals(
      parsed.receipt.reference.value,
      typedReference,
      `${provider} OCR reference`,
    );
    assertEquals(
      parsed.receipt.reference.typedMatch,
      "match",
      `${provider} typed comparison`,
    );
    assertEquals(verified.flags, [], `${provider} clean flags`);
    assert(
      !("status" in verified),
      `${provider} verifier returns evidence, never a payment status`,
    );
  }
});

Deno.test("verifies the live flattened MariBank Transaction Receipt layout", () => {
  const typedReference = "664744";
  const parsed = parseProviderReceipt(
    "maribank",
    MARIBANK_TRANSACTION_RECEIPT_OCR,
    { typedReference },
  );
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 800,
    expectedRecipientName: "Jan Kennith Magallano",
    expectedRecipientNameAliases: ["PaddleRage"],
    expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
    bookingStartedAt: "2026-09-18T16:10:49.158Z",
    bookingStartedDate: "2026-09-19",
  });

  assert(parsed.provider === "maribank", "MariBank provider");
  assert(verified.provider === "maribank", "MariBank verification");
  assertEquals(parsed.receipt.reference.value, typedReference, "reference");
  assertEquals(parsed.receipt.amount.amount, 800, "amount");
  assertEquals(parsed.receipt.amount.reliable, true, "reliable amount");
  assertEquals(
    parsed.receipt.timestamp.instant,
    "2026-09-18T16:12:00.000Z",
    "Philippine timestamp",
  );
  assertEquals(parsed.receipt.recipient.nameRaw, "Paddlerage", "recipient");
  assertEquals(
    verified.recipientComparison.account,
    "ocr_compatible",
    "O/0-safe QR destination token",
  );
  assertEquals(verified.flags, [], "clean live MariBank flags");
});

Deno.test("flattened MariBank auto-verification remains fail closed", () => {
  const typedReference = "664744";
  const context = {
    ...CONTEXT,
    typedReference,
    expectedAmount: 800,
    expectedRecipientName: "Jan Kennith Magallano",
    expectedRecipientNameAliases: ["PaddleRage"],
    expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
    bookingStartedAt: "2026-09-18T16:10:49.158Z",
    bookingStartedDate: "2026-09-19",
  };
  const cases = [
    {
      label: "wrong destination account",
      text: MARIBANK_TRANSACTION_RECEIPT_OCR.replace(
        "DWQM4TK3JDO900NS8",
        "DWQM4TK3JDO900BAD",
      ),
      flag: "WRONG_GCASH_ACCOUNT",
    },
    {
      label: "wrong recipient",
      text: MARIBANK_TRANSACTION_RECEIPT_OCR.replace(
        "Paddlerage",
        "Other Merchant",
      ),
      flag: "RECEIVER_NAME_MISMATCH",
    },
    {
      label: "typed reference mismatch",
      text: MARIBANK_TRANSACTION_RECEIPT_OCR.replace("664744", "664745"),
      flag: "REF_MISMATCH",
    },
    {
      label: "missing official footer",
      text: MARIBANK_TRANSACTION_RECEIPT_OCR.replace(
        "Receipt generated from MariBank app",
        "",
      ),
      flag: "TRANSFER_STATUS_UNREADABLE",
    },
  ];
  for (const testCase of cases) {
    const parsed = parseProviderReceipt("maribank", testCase.text, {
      typedReference,
    });
    const verified = verifyProviderReceipt(parsed, context);
    assert(
      verified.flags.includes(testCase.flag),
      `${testCase.label} must produce ${testCase.flag}: ${verified.flags}`,
    );
  }
});

Deno.test("parses and verifies the live GoTyme Sent receipt layout", () => {
  const typedReference = "ITO260910112033018";
  const parsed = parseProviderReceipt("gotyme", GOTYME_LIVE_OCR, {
    typedReference,
  });
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 3600,
    expectedRecipientName: "Jan Kennith Magallano",
    expectedRecipientNameAliases: ["Paddle Rage"],
    bookingStartedAt: "2026-09-10T11:06:00.000Z",
    bookingStartedDate: "2026-09-10",
  });
  assert(parsed.provider === "gotyme", "GoTyme provider");
  assertEquals(
    parsed.receipt.reference.value,
    typedReference,
    "GoTyme reference",
  );
  assertEquals(parsed.receipt.railReference.value, "000018", "GoTyme trace ID");
  assertEquals(parsed.receipt.amount.amount, 3600, "GoTyme amount");
  assertEquals(
    parsed.receipt.timestamp.instant,
    "2026-09-10T11:20:00.000Z",
    "GoTyme Philippine timestamp",
  );
  assertEquals(parsed.receipt.recipient.phoneLast4, "7667", "recipient suffix");
  assertEquals(parsed.receipt.indicators.transferSuccess, true, "Sent status");
  assertEquals(verified.flags, [], "clean live GoTyme flags");
  assert(
    verified.dedupeKeys.some((item) => item.key === `gotyme:${typedReference}`),
    "GoTyme reference is replay-protected",
  );
  assert(
    !verified.dedupeKeys.some((item) => item.key === "instapay:000018"),
    "short GoTyme trace ID must not become a global replay key",
  );
});

Deno.test("verifies the reported GoTyme 24-hour receipt with OCR line splits", () => {
  const typedReference = "ITO260911114957001";
  const parsed = parseProviderReceipt("gotyme", GOTYME_REPORTED_24H_OCR, {
    typedReference,
  });
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 2200,
    expectedRecipientName: "Jan Kennith Magallano",
    bookingStartedAt: "2026-09-11T11:44:00.000Z",
    bookingStartedDate: "2026-09-11",
  });

  assert(parsed.provider === "gotyme", "GoTyme provider");
  assert(verified.provider === "gotyme", "GoTyme verification");
  assertEquals(parsed.receipt.reference.value, typedReference, "reference");
  assertEquals(parsed.receipt.railReference.value, "000001", "trace ID");
  assertEquals(parsed.receipt.recipient.phoneLast4, "7667", "phone suffix");
  assertEquals(
    parsed.receipt.timestamp.instant,
    "2026-09-11T11:49:00.000Z",
    "anchored GoTyme 24-hour timestamp",
  );
  assertEquals(
    verified.recipientComparison.name,
    "masked_compatible",
    "configured legal-name initials",
  );
  assertEquals(verified.flags, [], "reported receipt clean flags");
});

Deno.test("GoTyme 24-hour and initial handling stays fail closed", () => {
  const typedReference = "ITO260911114957001";
  const context = {
    ...CONTEXT,
    typedReference,
    expectedAmount: 2200,
    expectedRecipientName: "Jan Kennith Magallano",
    bookingStartedAt: "2026-09-11T11:44:00.000Z",
    bookingStartedDate: "2026-09-11",
  };
  const cases = [
    {
      label: "wrong legal-name initials",
      text: GOTYME_REPORTED_24H_OCR.replace("J M.", "J X."),
      flag: "RECEIVER_NAME_UNREADABLE",
    },
    {
      label: "wrong destination suffix",
      text: GOTYME_REPORTED_24H_OCR.replace("0······7667", "0······1234"),
      flag: "WRONG_GCASH_NUMBER",
    },
    {
      label: "unanchored 24-hour date",
      text: GOTYME_REPORTED_24H_OCR.replace(
        "Date\n11 Sep 2026 at 19:49",
        "Advertisement\n11 Sep 2026 at 19:49",
      ),
      flag: "TIME_UNREADABLE",
    },
  ];

  for (const testCase of cases) {
    const parsed = parseProviderReceipt("gotyme", testCase.text, {
      typedReference,
    });
    const verified = verifyProviderReceipt(parsed, context);
    assert(
      verified.flags.includes(testCase.flag),
      `${testCase.label} must produce ${testCase.flag}`,
    );
  }
});

Deno.test("GoTyme Sent layout keeps every financial safety gate", () => {
  const typedReference = "ITO260910112033018";
  const cases: Array<{
    label: string;
    text: string;
    context: Partial<typeof CONTEXT> & { typedReference?: string };
    flag: string;
  }> = [
    {
      label: "pending status",
      text: GOTYME_LIVE_OCR.replace("Sent", "Sent\nPending"),
      context: {},
      flag: "TRANSFER_STATUS_UNREADABLE",
    },
    {
      label: "missing trace ID",
      text: GOTYME_LIVE_OCR.replace("Trace ID\n000018", ""),
      context: {},
      flag: "INSTAPAY_REF_UNREADABLE",
    },
    {
      label: "wrong recipient suffix",
      text: GOTYME_LIVE_OCR.replace("0••••••7667", "0••••••1234"),
      context: {},
      flag: "WRONG_GCASH_NUMBER",
    },
    {
      label: "wrong recipient name",
      text: GOTYME_LIVE_OCR.replace("Paddle Rage", "Another Merchant"),
      context: {},
      flag: "RECEIVER_NAME_MISMATCH",
    },
    {
      label: "reference mismatch",
      text: GOTYME_LIVE_OCR,
      context: { typedReference: "ITO260910112039999" },
      flag: "REF_MISMATCH",
    },
    {
      label: "late receipt",
      text: GOTYME_LIVE_OCR,
      context: { bookingStartedAt: "2026-09-10T10:00:00.000Z" },
      flag: "TIME_EXPIRED",
    },
    {
      label: "receipt predates the reported booking",
      text: GOTYME_LIVE_OCR,
      context: { bookingStartedAt: "2026-09-10T13:06:00.000Z" },
      flag: "TIME_FUTURE",
    },
  ];

  for (const testCase of cases) {
    const caseTypedReference = testCase.context.typedReference ||
      typedReference;
    const parsed = parseProviderReceipt("gotyme", testCase.text, {
      typedReference: caseTypedReference,
    });
    const verified = verifyProviderReceipt(parsed, {
      ...CONTEXT,
      typedReference: caseTypedReference,
      expectedAmount: 3600,
      expectedRecipientName: "PaddleRage",
      bookingStartedAt: "2026-09-10T11:06:00.000Z",
      bookingStartedDate: "2026-09-10",
      ...testCase.context,
    });
    assert(
      verified.flags.includes(testCase.flag),
      `${testCase.label} must produce ${testCase.flag}`,
    );
  }
});

Deno.test("verifies the reported reordered GCash Express Send OCR layout", () => {
  const typedReference = "5045095386043";
  const parsed = parseProviderReceipt("gcash", REORDERED_GCASH_OCR, {
    typedReference,
  });
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 3600,
    expectedRecipientName: "Jan Kennith Magallano",
    bookingStartedAt: "2026-09-15T16:58:36.646Z",
    bookingStartedDate: "2026-09-16",
  });

  assert(parsed.provider === "gcash", "reordered GCash provider");
  assert(verified.provider === "gcash", "reordered GCash verification");
  assertEquals(parsed.parserVersion, "gcash_v1", "GCash parser version");
  assertEquals(parsed.receipt.amount.amount, 3600, "GCash amount");
  assertEquals(
    parsed.receipt.amount.reliable,
    true,
    "GCash amount reliability",
  );
  assertEquals(
    parsed.receipt.amount.ambiguous,
    false,
    "GCash amount ambiguity",
  );
  assertEquals(
    parsed.receipt.amount.matchingPrimaryAmountDisplays,
    true,
    "GCash amount display confirmation",
  );
  assertEquals(parsed.receipt.receiver.phone.last4, "7667", "phone suffix");
  assertEquals(
    verified.recipientComparison.phone,
    "last4_only",
    "masked phone comparison",
  );
  assertEquals(
    verified.recipientComparison.name,
    "masked_compatible",
    "flattened masked name comparison",
  );
  assertEquals(verified.flags, [], "clean reordered GCash flags");
});

Deno.test("exact GCash phone survives OCR-dropped recipient mask glyphs", () => {
  const typedReference = "0045177399378";
  const parsed = parseProviderReceipt(
    "gcash",
    `
Express Send
J.. KEH M.
+63 945 510 7667
Sent via GCash
Amount
1,050.00
Total Amount Sent
P1,050.00
Ref No. 0045 177 399378
Sep 18, 2026 11:02 AM
`,
    { typedReference },
  );
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 1050,
    expectedRecipientName: "Jan Kennith Magallano",
    bookingStartedAt: "2026-09-18T02:56:00.000Z",
    bookingStartedDate: "2026-09-18",
  });

  assert(parsed.provider === "gcash", "GCash provider");
  assert(verified.provider === "gcash", "GCash verification");
  assertEquals(verified.recipientComparison.phone, "exact", "exact phone");
  assertEquals(
    verified.recipientComparison.name,
    "inconclusive",
    "OCR-dropped name mask remains supporting-only",
  );
  assertEquals(verified.flags, [], "clean receipt can auto-verify");
});

Deno.test("flattened masked GCash recipient evidence remains fail closed", () => {
  const typedReference = "5045095386043";
  const context = {
    ...CONTEXT,
    typedReference,
    expectedAmount: 3600,
    expectedRecipientName: "Jan Kennith Magallano",
    bookingStartedAt: "2026-09-15T16:58:36.646Z",
    bookingStartedDate: "2026-09-16",
  };
  const cases = [
    {
      label: "wrong phone suffix",
      text: REORDERED_GCASH_OCR.replace("7667", "1234"),
      flag: "WRONG_GCASH_NUMBER",
    },
    {
      label: "wrong merged final initial",
      text: REORDERED_GCASH_OCR.replace("KE...HM.", "KE...HX."),
      flag: "RECEIVER_NAME_MISMATCH",
    },
    {
      label: "missing second amount display",
      text: REORDERED_GCASH_OCR.replace("P3600.00\n", ""),
      flag: "AMOUNT_UNREADABLE",
    },
  ];
  for (const testCase of cases) {
    const parsed = parseProviderReceipt("gcash", testCase.text, {
      typedReference,
    });
    const verified = verifyProviderReceipt(parsed, context);
    assert(
      verified.flags.includes(testCase.flag),
      `${testCase.label} must produce ${testCase.flag}`,
    );
  }
});

Deno.test("GCash verifier keeps a single amount display in review", () => {
  const typedReference = "2043350406766";
  const parsed = parseProviderReceipt(
    "gcash",
    GCASH_OCR.replace("Amount\n1,080.00\n", ""),
    { typedReference },
  );
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
  });

  assert(parsed.provider === "gcash", "single-display GCash provider");
  assertEquals(parsed.receipt.amount.amount, 1080, "single display amount");
  assertEquals(parsed.receipt.amount.reliable, true, "single display parse");
  assertEquals(
    parsed.receipt.amount.matchingPrimaryAmountDisplays,
    false,
    "single display confirmation",
  );
  assert(
    verified.flags.includes("AMOUNT_CONFIRMATION_UNREADABLE"),
    "single display must stay in review",
  );
});

Deno.test("GCash verifier catches a labeled amount contradicting the total block", () => {
  const typedReference = "4044666766999";
  const parsed = parseProviderReceipt(
    "gcash",
    `
J•• KE••••H M.
+63 945 510 7667
Sent via GCash
Amount P3,500.00
Amount P3,500.00
Total Amount Sent
55
3,600.00
P3600.00
Ref No. 4044666766999
Sep 4, 2026 1:36 AM
`,
    { typedReference },
  );
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 3500,
    expectedRecipientName: "Jan Kennith Magallano",
    bookingStartedAt: "2026-09-03T17:35:00.000Z",
    bookingStartedDate: "2026-09-04",
  });

  assert(parsed.provider === "gcash", "contradictory GCash provider");
  assertEquals(
    parsed.receipt.amount.conflictingPrimaryAmounts,
    true,
    "contradictory amount evidence",
  );
  assert(
    verified.flags.includes("AMOUNT_REVIEW"),
    "contradictory labels and total block must stay in review",
  );
});

Deno.test("GCash verifier inspects every bounded total block", () => {
  const typedReference = "4044666766999";
  const parsed = parseProviderReceipt(
    "gcash",
    `${REORDERED_GCASH_OCR}
Total Amount Sent
55
3,500.00
P3500.00
Ref No. 4044666766999
`,
    { typedReference },
  );
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 3600,
    expectedRecipientName: "Jan Kennith Magallano",
    bookingStartedAt: "2026-09-03T17:35:00.000Z",
    bookingStartedDate: "2026-09-04",
  });

  assert(parsed.provider === "gcash", "multi-block GCash provider");
  assertEquals(
    parsed.receipt.amount.conflictingPrimaryAmounts,
    true,
    "later total block contradiction",
  );
  assert(
    verified.flags.includes("AMOUNT_UNREADABLE") ||
      verified.flags.includes("AMOUNT_REVIEW"),
    "a later contradictory total block must stay in review",
  );
});

Deno.test("GCash verifier rejects a second total anchor without a Ref boundary", () => {
  const typedReference = "4044666766999";
  const parsed = parseProviderReceipt(
    "gcash",
    `${REORDERED_GCASH_OCR}
Total Amount Sent
55
3,500.00
P3500.00
`,
    { typedReference },
  );
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 3600,
    expectedRecipientName: "Jan Kennith Magallano",
    bookingStartedAt: "2026-09-03T17:35:00.000Z",
    bookingStartedDate: "2026-09-04",
  });

  assert(parsed.provider === "gcash", "duplicate-anchor GCash provider");
  assertEquals(
    parsed.receipt.amount.reliable,
    false,
    "duplicate total anchors are unreliable",
  );
  assert(
    verified.flags.includes("AMOUNT_UNREADABLE"),
    "a truncated duplicate total block must stay in review",
  );
});

Deno.test("GCash verifier rejects descriptive or same-line amount lookalikes", () => {
  const typedReference = "4044666766999";
  for (
    const [label, displays] of [
      ["descriptive", "Available balance P3,600.00\nDiscount 3,600.00"],
      ["same line", "P3,600.00 P3,600.00"],
    ] as const
  ) {
    const parsed = parseProviderReceipt(
      "gcash",
      `
J•• KE••••H M.
+63 945 510 7667
Sent via GCash
Amount
Total Amount Sent
55
${displays}
Ref No. 4044666766999
Sep 4, 2026 1:36 AM
`,
      { typedReference },
    );
    const verified = verifyProviderReceipt(parsed, {
      ...CONTEXT,
      typedReference,
      expectedAmount: 3600,
      expectedRecipientName: "Jan Kennith Magallano",
      bookingStartedAt: "2026-09-03T17:35:00.000Z",
      bookingStartedDate: "2026-09-04",
    });

    assert(parsed.provider === "gcash", `${label} GCash provider`);
    assert(
      verified.flags.includes("AMOUNT_UNREADABLE") ||
        verified.flags.includes("AMOUNT_CONFIRMATION_UNREADABLE"),
      `${label} lookalikes must stay in review`,
    );
  }
});

Deno.test("typed bank reference is comparison-only and cannot synthesize OCR evidence", () => {
  const matching = parseProviderReceipt("gotyme", GOTYME_OCR, {
    typedReference: "GTY2026083112345678",
  });
  const mismatched = parseProviderReceipt("gotyme", GOTYME_OCR, {
    typedReference: "GTY2026083112349999",
  });
  assertEquals(
    matching.receipt.reference.value,
    mismatched.receipt.reference.value,
    "OCR reference remains independent",
  );
  assertEquals(
    mismatched.receipt.reference.value,
    "GTY2026083112345678",
    "OCR value is retained",
  );
  assertEquals(
    mismatched.receipt.reference.typedMatch,
    "mismatch",
    "typed value only changes comparison evidence",
  );

  const withoutReference = parseProviderReceipt(
    "gotyme",
    GOTYME_OCR.replace("Transaction ID GTY2026083112345678", ""),
    { typedReference: "GTY2026083112345678" },
  );
  assertEquals(
    withoutReference.receipt.reference.value,
    null,
    "typed value never fills a missing OCR field",
  );
  assertEquals(
    withoutReference.receipt.reference.typedMatch,
    "ocr_missing",
    "missing OCR evidence is explicit",
  );
});

Deno.test("parses and verifies the live BPI-to-GCash receipt layout", () => {
  const typedReference = "1624507073805";
  const parsed = parseProviderReceipt("bpi", BPI_OCR, { typedReference });
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 3600,
    expectedRecipientName: "PaddleRage",
    expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
    bookingStartedAt: "2026-09-01T23:06:00.000Z",
    bookingStartedDate: "2026-09-02",
  });
  assert(parsed.provider === "bpi", "BPI provider");
  assertEquals(parsed.parserVersion, "bpi_to_gcash_v1", "BPI parser version");
  assertEquals(
    parsed.receipt.reference.value,
    typedReference,
    "BPI confirmation",
  );
  assertEquals(
    parsed.receipt.transactionReference.value,
    "099408",
    "BPI transaction reference",
  );
  assertEquals(parsed.receipt.amount.amount, 3600, "BPI transfer amount");
  assertEquals(
    parsed.receipt.timestamp.instant,
    "2026-09-01T23:08:34.000Z",
    "BPI GMT+8 timestamp",
  );
  assertEquals(verified.flags, [], "clean BPI flags");
  assert(
    verified.dedupeKeys.some((item) => item.key === "bpi:1624507073805"),
    "BPI confirmation is replay-protected",
  );
  assert(
    verified.dedupeKeys.some((item) => item.key === "bpi_transaction:099408"),
    "BPI transaction reference is replay-protected",
  );
});

Deno.test("BPI typed confirmation is comparison-only and mismatches fail closed", () => {
  const parsed = parseProviderReceipt("bpi", BPI_OCR, {
    typedReference: "1624507073999",
  });
  assert(parsed.provider === "bpi", "BPI provider");
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference: "1624507073999",
    expectedAmount: 3600,
    expectedRecipientName: "PaddleRage",
    expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
    bookingStartedAt: "2026-09-01T23:06:00.000Z",
    bookingStartedDate: "2026-09-02",
  });
  assertEquals(
    parsed.receipt.reference.value,
    "1624507073805",
    "OCR evidence remains independent of typed confirmation",
  );
  assert(verified.flags.includes("REF_MISMATCH"), "BPI mismatch is flagged");
});

Deno.test("BPI missing transaction or wrong recipient stays in review", () => {
  const typedReference = "1624507073805";
  const parsed = parseProviderReceipt(
    "bpi",
    BPI_OCR
      .replace("Transaction Ref. No. 099408", "")
      .replace("PaddleRage (QR Code)", "Another Merchant (QR Code)"),
    { typedReference },
  );
  assert(parsed.provider === "bpi", "BPI provider");
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference,
    expectedAmount: 3600,
    expectedRecipientName: "PaddleRage",
    expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
    bookingStartedAt: "2026-09-01T23:06:00.000Z",
    bookingStartedDate: "2026-09-02",
  });
  assert(
    verified.flags.includes("BPI_TRANSACTION_UNREADABLE"),
    "missing independent replay reference is flagged",
  );
  assert(
    verified.flags.includes("RECEIVER_NAME_MISMATCH"),
    "wrong BPI QR recipient is flagged",
  );
});

Deno.test("shared InstaPay key catches cross-provider receipt replay", () => {
  const gotyme = parseProviderReceipt("gotyme", GOTYME_OCR, {
    typedReference: "GTY2026083112345678",
  });
  const maribank = parseProviderReceipt("maribank", MARIBANK_OCR, {
    typedReference: "MB2026083198765432",
  });
  const gotymeEvidence = verifyProviderReceipt(gotyme, {
    ...CONTEXT,
    typedReference: "GTY2026083112345678",
  });
  const maribankEvidence = verifyProviderReceipt(maribank, {
    ...CONTEXT,
    typedReference: "MB2026083198765432",
  });
  const gotymeRail = gotymeEvidence.dedupeKeys.find((item) =>
    item.providerKey === "instapay"
  );
  const maribankRail = maribankEvidence.dedupeKeys.find((item) =>
    item.providerKey === "instapay"
  );
  assertEquals(
    gotymeRail?.key,
    "instapay:987654321234",
    "GoTyme shared rail key",
  );
  assertEquals(
    maribankRail?.key,
    gotymeRail?.key,
    "MariBank shares the rail replay namespace",
  );
  assert(
    gotymeEvidence.dedupeKeys.some((item) =>
      item.key === "gotyme:GTY2026083112345678"
    ),
    "GoTyme primary reference remains provider-namespaced",
  );
  assert(
    maribankEvidence.dedupeKeys.some((item) =>
      item.key === "maribank:MB2026083198765432"
    ),
    "MariBank primary reference remains provider-namespaced",
  );
});

Deno.test("mismatched, unreadable, and competing-provider receipts produce flags only", () => {
  const parsed = parseProviderReceipt(
    "gotyme",
    GOTYME_OCR
      .replace("GoTyme Bank", "MariBank")
      .replace("Transaction ID GTY2026083112345678", "")
      .replace("PHP 1,080.00", "PHP 80.00"),
    { typedReference: "GTY2026083112345678" },
  );
  const verified = verifyProviderReceipt(parsed, {
    ...CONTEXT,
    typedReference: "GTY2026083112345678",
  });
  for (
    const flag of [
      "GOTYME_RECEIPT_UNREADABLE",
      "METHOD_MISMATCH",
      "REF_UNREADABLE",
      "AMOUNT_MISMATCH",
    ]
  ) {
    assert(verified.flags.includes(flag), `expected ${flag}`);
  }
  assert(
    !("status" in verified),
    "invalid evidence cannot auto-reject, cancel, or approve",
  );
});

Deno.test("unknown provider dispatch fails closed", () => {
  let error: unknown = null;
  try {
    parseProviderReceipt("unknown-bank", GOTYME_OCR, {
      typedReference: "GTY2026083112345678",
    });
  } catch (caught) {
    error = caught;
  }
  assert(
    error instanceof UnsupportedReceiptProviderError,
    "unknown providers must throw before parsing",
  );
});

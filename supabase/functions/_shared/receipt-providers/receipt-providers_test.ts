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

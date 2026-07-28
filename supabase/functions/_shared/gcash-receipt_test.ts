import {
  compareGcashMaskedName,
  compareGcashRecipient,
  normalizeGcashMobile,
  parseGcashReceipt,
} from "./gcash-receipt.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const USER_GCASH_OCR = `
J•• KE••••H M.
+63 945 510 7667
Sent via GCash
Amount
12.00
Total Amount Sent
₱12.00
Ref No. 2043350406766 Jul 28, 2026 10:41 AM
279g (gCO2e)
By going digital, you reduce your carbon footprint.
`;

const EXPECTED_RECIPIENT = {
  phone: "09455107667",
  name: "Jan Kennith Magallano",
};

Deno.test("parses the supplied masked-name GCash receipt", () => {
  const parsed = parseGcashReceipt(USER_GCASH_OCR, {
    typedReference: "2043350406766",
  });

  assertEquals(parsed.provider, "gcash", "provider");
  assertEquals(parsed.reference.value, "2043350406766", "reference");
  assertEquals(parsed.reference.source, "ref_label", "reference source");
  assertEquals(parsed.reference.typedMatch, "match", "typed reference");
  assertEquals(parsed.amount.amount, 12, "amount");
  assertEquals(parsed.amount.reliable, true, "amount reliability");
  assertEquals(parsed.amount.ambiguous, false, "amount ambiguity");
  assertEquals(
    parsed.amount.conflictingPrimaryAmounts,
    false,
    "amount consistency",
  );
  assertEquals(parsed.timestamp.date, "2026-07-28", "receipt date");
  assertEquals(parsed.timestamp.time24, "10:41", "receipt time");
  assertEquals(
    parsed.timestamp.instant,
    "2026-07-28T02:41:00.000Z",
    "PH instant",
  );
  assertEquals(parsed.timestamp.completeness, "date_time", "timestamp");
  assertEquals(
    parsed.receiver.phone.raw,
    "+63 945 510 7667",
    "receiver phone raw",
  );
  assertEquals(
    parsed.receiver.phone.normalized,
    "9455107667",
    "receiver phone normalized",
  );
  assertEquals(parsed.receiver.phone.visibility, "full", "phone visibility");
  assertEquals(
    parsed.receiver.name.raw,
    "J•• KE••••H M.",
    "masked receiver name",
  );
  assertEquals(parsed.receiver.name.visibility, "masked", "name visibility");
  assertEquals(
    parsed.indicators.sentViaGcash,
    true,
    "sent-via-GCash indicator",
  );
  assertEquals(
    parsed.indicators.totalAmountSent,
    true,
    "total-amount indicator",
  );
  assertEquals(
    parsed.indicators.referenceLabel,
    true,
    "reference indicator",
  );
  assertEquals(
    parsed.indicators.classification,
    "gcash",
    "receipt classification",
  );

  const comparison = compareGcashRecipient(
    parsed.receiver,
    EXPECTED_RECIPIENT,
  );
  assertEquals(comparison.phone, "exact", "receiver phone comparison");
  assertEquals(
    comparison.name,
    "masked_compatible",
    "masked receiver comparison",
  );
  assertEquals(
    comparison.nameSupportingOnly,
    true,
    "masked name is supporting only",
  );
  assert(
    !parsed.amount.candidates.some((candidate) => candidate.amount === 279),
    "carbon figure must never become an amount",
  );
});

Deno.test("matches bullet dot and collapsed GCash name masks", () => {
  for (
    const observed of [
      "J•• KE••••H M.",
      "J.. KE....H M.",
      "J• KE••H M.",
    ]
  ) {
    assertEquals(
      compareGcashMaskedName(observed, "Jan Kennith Magallano"),
      "masked_compatible",
      observed,
    );
  }
});

Deno.test("matches a fully visible receiver name exactly", () => {
  assertEquals(
    compareGcashMaskedName(
      "Jan Kennith Magallano",
      "Jan Kennith Magallano",
    ),
    "exact",
    "full receiver name",
  );
});

Deno.test("rejects visible contradictions in a masked receiver name", () => {
  assertEquals(
    compareGcashMaskedName("J•• KA••••H M.", "Jan Kennith Magallano"),
    "mismatch",
    "given-name anchor conflict",
  );
  assertEquals(
    compareGcashMaskedName("J•• KE••••H R.", "Jan Kennith Magallano"),
    "mismatch",
    "surname initial conflict",
  );
});

Deno.test("does not overstate a masked name with too few visible letters", () => {
  assertEquals(
    compareGcashMaskedName("J•• ••••••• M.", "Jan Kennith Magallano"),
    "inconclusive",
    "two visible initials",
  );
});

Deno.test("a wrong full receiver phone cannot be rescued by the name", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(
      "+63 945 510 7667",
      "+63 945 510 9999",
    ),
  );
  const comparison = compareGcashRecipient(
    parsed.receiver,
    EXPECTED_RECIPIENT,
  );
  assertEquals(comparison.phone, "mismatch", "wrong receiver phone");
  assertEquals(
    comparison.name,
    "masked_compatible",
    "name remains separate evidence",
  );
});

Deno.test("phone last four digits elsewhere cannot create a receiver match", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR
      .replace("+63 945 510 7667\n", "")
      .replace("2043350406766", "2043350407667"),
  );
  const comparison = compareGcashRecipient(
    parsed.receiver,
    EXPECTED_RECIPIENT,
  );
  assertEquals(parsed.receiver.phone.visibility, "missing", "receiver phone");
  assertEquals(comparison.phone, "missing", "no global last-four match");
});

Deno.test("normalizes supported full Philippine mobile formats", () => {
  for (
    const value of [
      "0945 510 7667",
      "+63 945 510 7667",
      "945-510-7667",
    ]
  ) {
    assertEquals(
      normalizeGcashMobile(value),
      "9455107667",
      `normalize ${value}`,
    );
  }
  assertEquals(normalizeGcashMobile("945510766"), null, "short mobile");
  assertEquals(normalizeGcashMobile("94551076670"), null, "long mobile");
});

Deno.test("parses a masked receiver phone as last-four evidence only", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(
      "+63 945 510 7667",
      "+63 9•• ••• 7667",
    ),
  );
  const comparison = compareGcashRecipient(
    parsed.receiver,
    EXPECTED_RECIPIENT,
  );
  assertEquals(parsed.receiver.phone.visibility, "masked", "masked phone");
  assertEquals(parsed.receiver.phone.normalized, null, "no invented phone");
  assertEquals(parsed.receiver.phone.last4, "7667", "visible last four");
  assertEquals(comparison.phone, "last4_only", "partial phone comparison");
});

Deno.test("receiver phone digits are never parsed as the GCash reference", () => {
  const parsed = parseGcashReceipt(USER_GCASH_OCR);
  assertEquals(parsed.reference.value, "2043350406766", "labeled reference");
  assert(
    parsed.reference.value !== parsed.receiver.phone.normalized,
    "reference and phone must remain distinct",
  );
});

Deno.test("normalizes a spaced labeled GCash reference", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(
      "Ref No. 2043350406766",
      "Ref No. 2043 3504 06766",
    ),
  );
  assertEquals(parsed.reference.value, "2043350406766", "spaced reference");
  assertEquals(parsed.reference.source, "ref_label", "spaced ref source");
});

Deno.test("keeps OCR evidence independent from a mismatched typed reference", () => {
  const parsed = parseGcashReceipt(USER_GCASH_OCR, {
    typedReference: "2043350406767",
  });
  assertEquals(
    parsed.reference.value,
    "2043350406766",
    "OCR reference remains authoritative evidence",
  );
  assertEquals(parsed.reference.typedMatch, "mismatch", "typed mismatch");
});

Deno.test("marks a unique standalone reference as medium-confidence", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace("Ref No. 2043350406766", "2043350406766"),
  );
  assertEquals(parsed.reference.value, "2043350406766", "standalone ref");
  assertEquals(parsed.reference.source, "standalone", "standalone source");
  assertEquals(parsed.reference.confidence, "medium", "standalone confidence");
});

Deno.test("refuses two different standalone 13-digit references", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(
      "Ref No. 2043350406766",
      "2043350406766\n2043350406767",
    ),
  );
  assertEquals(parsed.reference.value, null, "ambiguous reference");
  assert(
    parsed.issues.includes("AMBIGUOUS_REFERENCE"),
    "ambiguous reference issue",
  );
});

Deno.test("parses cross-line bare GCash amounts with label evidence", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace("₱12.00", "12.00"),
  );
  assertEquals(parsed.amount.amount, 12, "cross-line amount");
  assertEquals(parsed.amount.reliable, true, "cross-line reliability");
  assertEquals(parsed.amount.ambiguous, false, "cross-line ambiguity");
});

Deno.test("never suffix-parses a thousands GCash amount", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR
      .replace(/\n12\.00\n/, "\n1,080.00\n")
      .replace("₱12.00", "₱1,080.00"),
  );
  assertEquals(parsed.amount.amount, 1080, "thousands amount");
  assert(
    !parsed.amount.candidates.some((candidate) => candidate.amount === 80),
    "must not parse the comma tail",
  );
});

Deno.test("surfaces conflicting principal GCash amounts", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR
      .replace("Amount\n12.00", "Amount P12.00")
      .replace("₱12.00", "₱1,200.00"),
  );
  assertEquals(parsed.amount.amount, 1200, "selected total sent");
  assertEquals(
    parsed.amount.conflictingPrimaryAmounts,
    true,
    "conflicting amount diagnostic",
  );
  assert(
    parsed.issues.includes("CONFLICTING_PRIMARY_AMOUNTS"),
    "conflicting amount issue",
  );
});

Deno.test("keeps a date-only GCash timestamp incomplete", () => {
  const parsed = parseGcashReceipt(
    USER_GCASH_OCR.replace(" Jul 28, 2026 10:41 AM", "\nJul 28, 2026"),
  );
  assertEquals(parsed.timestamp.date, "2026-07-28", "date only");
  assertEquals(parsed.timestamp.time24, null, "missing time");
  assertEquals(parsed.timestamp.instant, null, "missing instant");
  assertEquals(parsed.timestamp.completeness, "date_only", "date-only state");
});

Deno.test("rejects rollover dates and invalid twelve-hour times", () => {
  for (
    const invalidTimestamp of [
      "Jul 32, 2026 10:41 AM",
      "Jul 28, 2026 13:61 PM",
    ]
  ) {
    const parsed = parseGcashReceipt(
      USER_GCASH_OCR.replace(
        "Jul 28, 2026 10:41 AM",
        invalidTimestamp,
      ),
    );
    assertEquals(
      parsed.timestamp.completeness,
      "invalid",
      invalidTimestamp,
    );
    assert(
      parsed.issues.includes("TIMESTAMP_INVALID"),
      `${invalidTimestamp} issue`,
    );
  }
});

Deno.test("converts twelve AM and PM correctly", () => {
  const midnight = parseGcashReceipt(
    USER_GCASH_OCR.replace("10:41 AM", "12:00 AM"),
  );
  const noon = parseGcashReceipt(
    USER_GCASH_OCR.replace("10:41 AM", "12:00 PM"),
  );
  assertEquals(midnight.timestamp.time24, "00:00", "midnight");
  assertEquals(noon.timestamp.time24, "12:00", "noon");
});

for (
  const [provider, evidence] of [
    ["bdopay", "BDO Pay"],
    ["maya", "Maya\nSent money via\nInstaPay QRPh"],
    ["bpi", "BPI Online\nTransfer successful"],
  ] as const
) {
  Deno.test(`classifies ${provider} evidence on GCash as a conflict`, () => {
    const parsed = parseGcashReceipt(`${USER_GCASH_OCR}\n${evidence}`);
    assertEquals(
      parsed.indicators.classification,
      "conflict",
      `${provider} method conflict`,
    );
    assert(
      parsed.indicators.competingProviders.includes(provider),
      `${provider} indicator`,
    );
    assert(
      parsed.issues.includes("COMPETING_PROVIDER"),
      `${provider} competing-provider issue`,
    );
  });
}

Deno.test("a total amount fragment alone is not a GCash receipt", () => {
  const parsed = parseGcashReceipt("Total Amount Sent ₱12.00");
  assertEquals(
    parsed.indicators.classification,
    "insufficient",
    "fragment classification",
  );
  assert(
    parsed.issues.includes("INSUFFICIENT_GCASH_INDICATORS"),
    "insufficient indicator issue",
  );
});

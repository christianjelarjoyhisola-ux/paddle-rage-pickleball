import { extractReceiptAmount } from "./receipt-amount.ts";

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

const suppliedMayaText = `
Sent money via
- P1,080.00
InstaPay QRPh
Jul 13, 2026, 08:03 pm
Account type G-Xchange Inc. / GCash
Account number DWQM4TK496R3UA1BS
Account name Paddle Rage Pickleball
Transfer Fee
P10.00
Reference ID A7B9 7F99 B743
InstaPay Ref. No 336212
maya
`;

Deno.test("Maya principal amount wins over its transfer fee", () => {
  const result = extractReceiptAmount(suppliedMayaText, {
    provider: "maya",
  });

  assertEquals(result.amount, 1080, "principal amount");
  assertEquals(result.reliable, true, "principal reliability");
  assertEquals(result.ambiguous, false, "principal ambiguity");
  assert(
    result.evidence.includes("maya_sent_money_context"),
    "Maya layout evidence should be retained",
  );
  const fee = result.candidates.find((candidate) => candidate.amount === 10);
  assert(fee, "transfer fee should remain visible for audit diagnostics");
  assertEquals(fee.excluded, true, "transfer fee exclusion");
  assert(
    fee.exclusionReasons.includes("transfer_fee"),
    "transfer fee should say why it was excluded",
  );
});

Deno.test("a genuine small Maya principal remains a reliable underpayment read", () => {
  const result = extractReceiptAmount(
    "Sent money via\n- P80.00\nInstaPay QRPh",
    { provider: "maya" },
  );

  assertEquals(result.amount, 80, "small Maya principal");
  assertEquals(result.reliable, true, "small principal reliability");
  assert(
    result.evidence.includes("maya_sent_money_context"),
    "a real small principal must still be eligible for server-side comparison",
  );
});

Deno.test("Maya dash bullets remain layout markers rather than negative signs", () => {
  for (const bullet of ["-", "–", "—", "−"]) {
    const result = extractReceiptAmount(
      `Sent money via\n${bullet} P1,080.00\nInstaPay QRPh`,
      { provider: "maya" },
    );
    assertEquals(result.amount, 1080, `${bullet} Maya bullet amount`);
    assertEquals(result.reliable, true, `${bullet} Maya bullet reliability`);
  }
});

Deno.test("a fee-only Maya read is not accepted as the principal", () => {
  const result = extractReceiptAmount(
    "Sent money via\nTransfer Fee P10.00\nmaya",
    { provider: "maya" },
  );

  assertEquals(result.amount, null, "fee-only amount");
  assertEquals(result.reliable, false, "fee-only reliability");
  assertEquals(result.reason, "all_candidates_excluded", "fee-only reason");
});

for (
  const [label, value] of [
    ["ASCII P attached", "P1,080.00"],
    ["ASCII P spaced", "P 1,080.00"],
    ["PHP attached", "PHP1,080.00"],
    ["peso sign attached", "₱1,080.00"],
  ] as const
) {
  Deno.test(`parses Maya ${label}`, () => {
    const result = extractReceiptAmount(
      `Sent money via\n- ${value}\nInstaPay QRPh`,
      {
        provider: "maya",
      },
    );
    assertEquals(result.amount, 1080, label);
    assertEquals(result.reliable, true, `${label} reliability`);
    assert(
      !result.evidence.includes("maya_ocr_spacing_repair"),
      `${label} should not report an unnecessary spacing repair`,
    );
  });
}

for (
  const [label, value] of [
    ["split after one thousands digit", "P1,0 80.00"],
    ["space after thousands comma", "P1, 080.00"],
    ["space instead of thousands comma", "P1 080.00"],
  ] as const
) {
  Deno.test(`repairs conservative Maya OCR spacing: ${label}`, () => {
    const result = extractReceiptAmount(
      `Sent money via\n- ${value}\nInstaPay QRPh`,
      { provider: "maya" },
    );
    assertEquals(result.amount, 1080, label);
    assertEquals(result.reliable, true, `${label} reliability`);
    assert(
      result.evidence.includes("maya_ocr_spacing_repair"),
      `${label} repair evidence`,
    );
    assert(
      !result.candidates.some((candidate) => candidate.amount === 80),
      `${label} must not produce a suffix candidate`,
    );
  });
}

Deno.test("spaced thousands repair requires both Maya anchor and currency", () => {
  const withoutAnchor = extractReceiptAmount("Payment P1,0 80.00", {
    provider: "maya",
  });
  assertEquals(withoutAnchor.amount, null, "missing Maya anchor");
  assertEquals(withoutAnchor.reason, "no_candidates", "missing anchor reason");

  const withoutCurrency = extractReceiptAmount(
    "Sent money via\n1,0 80.00\nInstaPay QRPh",
    { provider: "maya" },
  );
  assertEquals(withoutCurrency.amount, null, "missing currency marker");
  assertEquals(
    withoutCurrency.reason,
    "no_candidates",
    "missing currency reason",
  );
});

Deno.test("malformed spaced grouping stays unreadable", () => {
  for (
    const value of [
      "P1 08.00",
      "P1,00 80.00",
      "P1 0800.00",
      "P0 080.00",
    ]
  ) {
    const result = extractReceiptAmount(`Sent money via\n${value}`, {
      provider: "maya",
    });
    assertEquals(result.amount, null, `malformed ${value}`);
    assertEquals(result.reason, "no_candidates", `malformed reason ${value}`);
  }
});

Deno.test("spaced Maya fee candidate remains excluded", () => {
  const result = extractReceiptAmount(
    "Sent money via\nTransfer Fee P1,0 80.00",
    { provider: "maya" },
  );
  assertEquals(result.amount, null, "spaced fee amount");
  assertEquals(result.reason, "all_candidates_excluded", "spaced fee reason");
  const fee = result.candidates.find((candidate) => candidate.amount === 1080);
  assert(fee, "spaced fee should remain in diagnostics");
  assertEquals(fee.excluded, true, "spaced fee exclusion");
  assert(fee.exclusionReasons.includes("transfer_fee"), "spaced fee evidence");
});

Deno.test("never suffix-parses a thousands amount as comma-tail digits", () => {
  const result = extractReceiptAmount("Sent money via\n- P1,080.00", {
    provider: "maya",
  });
  assertEquals(result.amount, 1080, "full thousands amount");
  assert(
    !result.candidates.some((candidate) => candidate.amount === 80),
    "the parser must never create an 80 candidate from ,080.00",
  );

  const bareSuffix = extractReceiptAmount("untrusted OCR fragment ,080.00", {
    provider: "maya",
  });
  assertEquals(bareSuffix.amount, null, "bare comma suffix");
  assertEquals(bareSuffix.reason, "no_candidates", "bare suffix reason");
});

Deno.test("explicit amount label works without a currency marker", () => {
  const result = extractReceiptAmount("Total amount sent: 1,080.00");
  assertEquals(result.amount, 1080, "labeled amount");
  assertEquals(result.reliable, true, "labeled amount reliability");
  assert(result.evidence.includes("total_label"), "total evidence");
});

Deno.test("amount labels apply to a bare value on the next OCR line", () => {
  const result = extractReceiptAmount(
    "Amount\n12.00\nTotal Amount Sent\n12.00",
    { provider: "gcash" },
  );
  assertEquals(result.amount, 12, "cross-line GCash amount");
  assertEquals(result.reliable, true, "cross-line amount reliability");
  assertEquals(result.ambiguous, false, "equivalent cross-line amounts");
  assert(result.evidence.includes("total_label"), "cross-line total evidence");
});

Deno.test("recovers two concordant GCash displays from reordered Vision text", () => {
  const result = extractReceiptAmount(
    `
1:36 1
Amount
Express Send
J•• KE••••H M.
+63 945 510 7667
Sent via GCash
Total Amount Sent
55
3,600.00
P3600.00
Ref No. 4044666766999
Sep 4, 2026 1:36 AM
279g (gCO2e)
`,
    { provider: "gcash" },
  );

  assertEquals(result.amount, 3600, "reordered GCash amount");
  assertEquals(result.reliable, true, "reordered GCash reliability");
  assertEquals(result.ambiguous, false, "reordered GCash ambiguity");
  assert(
    result.evidence.includes("gcash_concordant_amount_block"),
    "concordant block evidence",
  );
  assert(
    !result.candidates.some((candidate) => candidate.amount === 55),
    "integer status-bar noise must not become money",
  );
  assert(
    !result.candidates.some((candidate) => candidate.amount === 279),
    "carbon text outside the bounded block must not become money",
  );
});

Deno.test("GCash reordered block fails closed on conflicting displays", () => {
  const result = extractReceiptAmount(
    `
Sent via GCash
Total Amount Sent
55
3,500.00
P3600.00
Ref No. 4044666766999
`,
    { provider: "gcash" },
  );

  assertEquals(result.reliable, false, "conflicting display reliability");
  assert(
    !result.evidence.includes("gcash_concordant_amount_block"),
    "conflicting displays must not receive recovery evidence",
  );
});

Deno.test("GCash reordered block cannot use excluded money as corroboration", () => {
  for (
    const excludedLine of [
      "Account balance P3600.00",
      "Fee P3600.00",
    ]
  ) {
    const result = extractReceiptAmount(
      `
Sent via GCash
Total Amount Sent
55
${excludedLine}
3,600.00
Ref No. 4044666766999
`,
      { provider: "gcash" },
    );

    assertEquals(result.reliable, false, excludedLine);
    assert(
      !result.evidence.includes("gcash_concordant_amount_block"),
      `${excludedLine} must not corroborate the principal`,
    );
  }
});

Deno.test("negative-looking money is never normalized into a positive amount", () => {
  for (
    const value of [
      "-3,600.00",
      "P-3600.00",
      "P–3600.00",
      "P—3600.00",
      "P−3600.00",
      "-P3600.00",
      "−P3600.00",
      "P3600.00-",
      "P3600.00−",
      "(P3600.00)",
      "P(3600.00)",
    ]
  ) {
    const result = extractReceiptAmount(`Total Amount Sent\n${value}`, {
      provider: "gcash",
    });
    assertEquals(result.amount, null, value);
    assertEquals(result.reliable, false, `${value} reliability`);
  }

  const sameLine = extractReceiptAmount("Total Amount Sent -3,600.00", {
    provider: "gcash",
  });
  assertEquals(sameLine.amount, null, "same-line negative amount");

  const explicitPositive = extractReceiptAmount(
    "Total Amount Sent\nP+3600.00",
    {
      provider: "gcash",
    },
  );
  assertEquals(explicitPositive.amount, 3600, "explicit positive amount");
});

Deno.test("GCash block rejects signed and alphanumeric pseudo-displays", () => {
  const cases = [
    ["negative displays", "-3,600.00\nP-3600.00"],
    ["sign before marker", "3,600.00\n-P3600.00"],
    ["Unicode sign before marker", "3,600.00\n−P3600.00"],
    ["trailing negative sign", "3,600.00\nP3600.00-"],
    ["accounting parentheses", "3,600.00\n(P3600.00)"],
    ["letter prefix", "ABC3600.00\nP3600.00"],
    ["letter suffix", "3600.00XYZ\nP3600.00"],
    ["marked letter suffix", "3,600.00\nP3600.00XYZ"],
  ] as const;

  for (const [label, displays] of cases) {
    const result = extractReceiptAmount(
      `Sent via GCash\nTotal Amount Sent\n55\n${displays}\nRef No. 4044666766999`,
      { provider: "gcash" },
    );
    assertEquals(result.reliable, false, label);
    assert(
      !result.evidence.includes("gcash_concordant_amount_block"),
      `${label} must not receive recovery evidence`,
    );
  }
});

Deno.test("GCash block requires whole-line displays on separate lines", () => {
  for (
    const [label, displays] of [
      ["descriptive lines", "Available balance P3,600.00\nDiscount 3,600.00"],
      ["same-line repetition", "P3,600.00 P3,600.00"],
    ] as const
  ) {
    const result = extractReceiptAmount(
      `Sent via GCash\nTotal Amount Sent\n55\n${displays}\nRef No. 4044666766999`,
      { provider: "gcash" },
    );
    assertEquals(result.reliable, false, label);
    assert(
      !result.evidence.includes("gcash_concordant_amount_block"),
      `${label} must not receive recovery evidence`,
    );
  }
});

Deno.test("GCash reordered block requires repetition, currency, and Ref boundary", () => {
  const cases = [
    [
      "single display",
      "Sent via GCash\nTotal Amount Sent\n55\nP3600.00\nRef No. 4044666766999",
    ],
    [
      "no currency marker",
      "Sent via GCash\nTotal Amount Sent\n55\n3,600.00\n3600.00\nRef No. 4044666766999",
    ],
    [
      "second display after boundary",
      "Sent via GCash\nTotal Amount Sent\n55\nP3600.00\nRef No. 4044666766999\n3,600.00",
    ],
    [
      "missing boundary",
      "Sent via GCash\nTotal Amount Sent\n55\n3,600.00\nP3600.00",
    ],
  ] as const;

  for (const [label, text] of cases) {
    const result = extractReceiptAmount(text, { provider: "gcash" });
    assertEquals(result.reliable, false, label);
    assert(
      !result.evidence.includes("gcash_concordant_amount_block"),
      `${label} must not receive recovery evidence`,
    );
  }
});

Deno.test("reordered GCash recovery never applies to another provider", () => {
  const result = extractReceiptAmount(
    "Sent via GCash\nTotal Amount Sent\n55\n3,600.00\nP3600.00\nRef No. 4044666766999",
    { provider: "bpi" },
  );
  assertEquals(result.reliable, false, "non-GCash provider reliability");
  assert(
    !result.evidence.includes("gcash_concordant_amount_block"),
    "non-GCash provider evidence",
  );
});

Deno.test("a bare decimal remains untrusted without a preceding label", () => {
  const result = extractReceiptAmount("untrusted OCR fragment\n12.00", {
    provider: "gcash",
  });
  assertEquals(result.amount, null, "unlabeled bare decimal");
  assertEquals(result.reason, "no_candidates", "unlabeled decimal reason");
});

Deno.test("fee reference date and account candidates are excluded", () => {
  const result = extractReceiptAmount(
    `
Transfer Fee P10.00
Service fee
P20.00
Reference ID P300.00
Date total P400.00
Account balance P500.00
Sent money via
P1,080.00
`,
    { provider: "maya" },
  );

  assertEquals(result.amount, 1080, "only principal remains eligible");
  for (const amount of [10, 20, 300, 400, 500]) {
    const candidate = result.candidates.find((item) => item.amount === amount);
    assert(candidate, `candidate ${amount} should be retained for diagnostics`);
    assertEquals(candidate.excluded, true, `candidate ${amount} exclusion`);
  }
});

Deno.test("fee labels remain attached across blank OCR lines", () => {
  const result = extractReceiptAmount(
    `
Sent money via
P1,080.00
Service Fee

P20.00
`,
    { provider: "maya" },
  );

  assertEquals(result.amount, 1080, "principal across blank OCR lines");
  const fee = result.candidates.find((candidate) => candidate.amount === 20);
  assert(fee, "fee candidate across blank OCR lines");
  assertEquals(fee.excluded, true, "blank-line fee exclusion");
  assert(fee.exclusionReasons.includes("service_fee"), "service fee reason");
});

Deno.test("equivalent receipt-context candidates are ambiguous without expected amount", () => {
  const result = extractReceiptAmount("Amount P500.00\nAmount P600.00");
  assertEquals(result.amount, null, "ambiguous amount");
  assertEquals(result.reliable, false, "ambiguous reliability");
  assertEquals(result.ambiguous, true, "ambiguous flag");
  assertEquals(result.reason, "ambiguous", "ambiguous reason");
});

Deno.test("a weaker amount label cannot override the Maya principal", () => {
  const result = extractReceiptAmount(
    `
Sent money via
P1,080.00
InstaPay QRPh
Amount P500.00
`,
    { provider: "maya" },
  );

  assertEquals(result.amount, 1080, "stronger Maya receipt evidence");
});

Deno.test("an excluded fee can never override the Maya principal", () => {
  const result = extractReceiptAmount(
    `
Sent money via
P1,080.00
Transfer Fee P10.00
`,
    { provider: "maya" },
  );
  assertEquals(result.amount, 1080, "excluded fee must not be selected");
});

Deno.test("a currency-only candidate is returned but conservatively unreliable", () => {
  const result = extractReceiptAmount("Payment receipt\nP750.00");
  assertEquals(result.amount, 750, "currency-only amount");
  assertEquals(result.reliable, false, "currency-only reliability");
  assertEquals(result.ambiguous, false, "currency-only ambiguity");
});

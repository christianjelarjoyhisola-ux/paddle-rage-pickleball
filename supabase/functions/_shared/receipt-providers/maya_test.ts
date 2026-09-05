import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";
import { parseMayaToGcashReceipt, verifyMayaToGcashReceipt } from "./maya.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const RECEIPT = `
12:04
Sent money via
- ₱800.00
InstaPay
Sep 5, 2026, 12:02 pm
You may confirm the status of your transaction with your recipient.
Share
payment
Account type
G-Xchange Inc. / GCash
Account number
09455107667
Account name
J..KE....H M.
Transfer Fee
₱10.00
Reference ID
B794 2F55 EC99
InstaPay Ref. No
797289
maya
Get help
`;

const CONTEXT = {
  typedReference: "B7942F55EC99",
  expectedAmount: 800,
  pricingAvailable: true,
  amountTolerance: 0.01,
  expectedRecipientNumber: "09455107667",
  expectedRecipientName: "Jan Kennith Magallano",
  bookingStartedAt: "2026-09-05T03:58:00.000Z",
  bookingStartedDate: "2026-09-05",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};

function flagsFor(
  receipt: string,
  context: Partial<typeof CONTEXT> = {},
): string[] {
  const merged = { ...CONTEXT, ...context };
  return verifyMayaToGcashReceipt(
    parseMayaToGcashReceipt(receipt, {
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

Deno.test("Maya parser verifies the supplied live Maya-to-GCash layout", () => {
  const parsed = parseMayaToGcashReceipt(RECEIPT, {
    typedReference: CONTEXT.typedReference,
  });
  const evidence = verifyMayaToGcashReceipt(parsed, CONTEXT);

  assertEquals(parsed.parserVersion, "maya_to_gcash_v1", "parser version");
  assertEquals(parsed.reference.value, "B7942F55EC99", "Maya Reference ID");
  assertEquals(parsed.reference.typedMatch, "match", "typed reference match");
  assertEquals(parsed.railReference.value, "797289", "InstaPay reference");
  assertEquals(parsed.amount.amount, 800, "principal amount");
  assertEquals(parsed.amount.reliable, true, "principal amount reliability");
  assert(
    parsed.amount.evidence.includes("maya_sent_money_context"),
    "Maya amount must be anchored to the receipt heading",
  );
  assertEquals(parsed.transferFee.amount, 10, "separate transfer fee");
  assertEquals(parsed.timestamp.date, "2026-09-05", "receipt date");
  assertEquals(parsed.timestamp.time24, "12:02", "receipt time, not status-bar clock");
  assertEquals(parsed.timestamp.zone, "Asia/Manila", "receipt timezone");
  assertEquals(
    parsed.timestamp.instant,
    "2026-09-05T04:02:00.000Z",
    "Manila receipt timestamp",
  );
  assertEquals(
    parsed.recipient.phoneNormalized,
    "9455107667",
    "full destination mobile",
  );
  assertEquals(parsed.recipient.nameRaw, "J..KE....H M.", "masked name");
  assertEquals(evidence.recipientComparison.phone, "exact", "phone match");
  assertEquals(
    evidence.recipientComparison.name,
    "masked_compatible",
    "masked name match",
  );
  assertEquals(parsed.indicators.completionScreen, true, "completion screen");
  assertEquals(parsed.indicators.destinationGcash, true, "GCash destination");
  assertEquals(evidence.flags.length, 0, JSON.stringify(evidence.flags));
  assert(
    evidence.dedupeKeys.some((item) =>
      item.key === "maya:B7942F55EC99" && item.providerKey === "maya"
    ),
    "Maya transaction replay key",
  );
  assert(
    evidence.dedupeKeys.some((item) =>
      item.key === "maya_instapay:797289" &&
      item.providerKey === "maya_instapay"
    ),
    "legacy-compatible Maya InstaPay replay key",
  );
});

Deno.test("receipt registry dispatches Maya to its dedicated parser and verifier", () => {
  const parsed = parseProviderReceipt("maya", RECEIPT, {
    typedReference: CONTEXT.typedReference,
  });
  assert(parsed.provider === "maya", "dedicated Maya parser dispatch");
  assertEquals(parsed.parserVersion, "maya_to_gcash_v1", "registry version");
  const evidence = verifyProviderReceipt(parsed, CONTEXT);
  assert(evidence.provider === "maya", "dedicated Maya verifier dispatch");
  assertEquals(evidence.flags.length, 0, JSON.stringify(evidence.flags));
});

Deno.test("Maya parser handles flattened two-column Vision text", () => {
  const flattened = RECEIPT
    .replace(
      "Account type\nG-Xchange Inc. / GCash\nAccount number\n09455107667\nAccount name\nJ..KE....H M.",
      "Account type\nAccount number\nAccount name\nG-Xchange Inc. / GCash\n09455107667\nJ..KE....H M.",
    )
    .replace(
      "Reference ID\nB794 2F55 EC99\nInstaPay Ref. No\n797289",
      "Reference ID\nInstaPay Ref. No\nB794 2F55 EC99\n797289",
    );
  const parsed = parseMayaToGcashReceipt(flattened, {
    typedReference: CONTEXT.typedReference,
  });
  assertEquals(parsed.reference.value, "B7942F55EC99", "flattened reference");
  assertEquals(
    parsed.railReference.value,
    "797289",
    "flattened rail reference",
  );
  assertEquals(
    parsed.recipient.phoneNormalized,
    "9455107667",
    "flattened phone",
  );
  assertEquals(parsed.recipient.nameRaw, "J..KE....H M.", "flattened name");
  assertEquals(
    flagsFor(flattened).length,
    0,
    JSON.stringify(flagsFor(flattened)),
  );
});

Deno.test("Maya amount is exact and can never be replaced by the transfer fee", () => {
  assertEquals(
    flagsFor(RECEIPT).length,
    0,
    "fee must not compete with principal",
  );
  assertFlag(
    RECEIPT.replace("- ₱800.00", "- ₱700.00"),
    "AMOUNT_MISMATCH",
  );
  assertFlag(
    RECEIPT.replace("- ₱800.00", "- ₱900.00"),
    "AMOUNT_MISMATCH",
  );
  assertFlag(
    RECEIPT.replace("- ₱800.00\n", ""),
    "AMOUNT_UNREADABLE",
    { expectedAmount: 10 },
  );
  assertFlag(
    RECEIPT.replace("- ₱800.00", "- ₱8 00.00"),
    "AMOUNT_UNREADABLE",
  );
});

Deno.test("Maya typed reference is comparison-only and both receipt refs are required", () => {
  const mismatched = parseMayaToGcashReceipt(RECEIPT, {
    typedReference: "B7942F55EC98",
  });
  assertEquals(
    mismatched.reference.value,
    "B7942F55EC99",
    "OCR reference remains independent",
  );
  assertFlag(RECEIPT, "REF_MISMATCH", {
    typedReference: "B7942F55EC98",
  });
  assertFlag(RECEIPT, "REF_FORMAT_INVALID", { typedReference: "797289" });
  assertFlag(
    RECEIPT.replace("Reference ID\n", "Receipt note\n"),
    "REF_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace("InstaPay Ref. No\n", "Network note\n"),
    "INSTAPAY_REF_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace(
      "B794 2F55 EC99",
      "B794 2F55 EC99\nReference ID\nB794 2F55 EC98",
    ),
    "REF_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace(
      "Reference ID\nB794 2F55 EC99",
      "Reference ID B794 2F55 EC99 B794 2F55 EC98",
    ),
    "REF_UNREADABLE",
  );
  assertFlag(
    RECEIPT.replace(
      "InstaPay Ref. No\n797289",
      "InstaPay Ref. No 797289 797290",
    ),
    "INSTAPAY_REF_UNREADABLE",
  );
});

Deno.test("Maya auto-verification requires both transaction date and time", () => {
  for (const incomplete of [
    "Sep 5, 2026",
    "12:02 pm",
    "Sep 5, 2026, 12:02",
    "Sep 5, 2026, 12:75 pm",
    "Feb 30, 2026, 12:02 pm",
    "",
  ]) {
    const receipt = RECEIPT.replace("Sep 5, 2026, 12:02 pm", incomplete);
    assertFlag(receipt, "TIME_UNREADABLE");
    assert(
      parseMayaToGcashReceipt(receipt).timestamp.instant === null,
      "Incomplete or invalid receipt time must never use the phone clock or booking time",
    );
  }
  const midnight = parseMayaToGcashReceipt(
    RECEIPT.replace("12:02 pm", "12:02 am"),
  );
  assertEquals(midnight.timestamp.time24, "00:02", "midnight conversion");
  assertEquals(midnight.timestamp.instant, "2026-09-04T16:02:00.000Z", "midnight UTC storage");
});

Deno.test("Maya verifier binds the exact GCash account and masked recipient name", () => {
  assertFlag(
    RECEIPT.replace("09455107667", "09171234567"),
    "WRONG_GCASH_NUMBER",
  );
  assertFlag(
    RECEIPT.replace("J..KE....H M.", "X..YZ....Q Z."),
    "RECEIVER_NAME_MISMATCH",
  );
  assertFlag(
    RECEIPT.replace("G-Xchange Inc. / GCash", "Different Bank"),
    "GXI_DESTINATION_UNREADABLE",
  );
  assertFlag(RECEIPT, "MERCHANT_CONFIG_MISSING", {
    expectedRecipientNumber: "",
  });
  assertFlag(RECEIPT, "MERCHANT_CONFIG_MISSING", {
    expectedRecipientName: "",
  });
  const conflictingDestination = RECEIPT.replace(
    "Account type\nG-Xchange Inc. / GCash",
    "Account type Other Bank\nAccount type\nG-Xchange Inc. / GCash",
  );
  assertFlag(conflictingDestination, "GXI_DESTINATION_UNREADABLE");
  assert(
    parseMayaToGcashReceipt(conflictingDestination).issues.includes(
      "AMBIGUOUS_DESTINATION",
    ),
    "contradictory account types must remain ambiguous",
  );
  const conflictingAccount = RECEIPT.replace(
    "Account number\n09455107667",
    "Account number NOT READABLE\nAccount number\n09455107667",
  );
  assertFlag(conflictingAccount, "NUMBER_UNREADABLE");
  assert(
    parseMayaToGcashReceipt(conflictingAccount).issues.includes(
      "AMBIGUOUS_ACCOUNT_NUMBER",
    ),
    "a malformed duplicate account must invalidate the valid-looking account",
  );
  assertFlag(
    RECEIPT.replace(
      "Account name\nJ..KE....H M.",
      "Account name Other Person\nAccount name\nJ..KE....H M.",
    ),
    "RECEIVER_NAME_UNREADABLE",
  );
});

Deno.test("Maya verifier rejects incomplete, pending, failed, or competing screens", () => {
  assertFlag(RECEIPT.replace("maya\n", "wallet\n"), "MAYA_UNREADABLE");
  assertFlag(
    RECEIPT.replace("Sent money via", "Transfer details"),
    "TRANSFER_STATUS_UNREADABLE",
  );
  assertFlag(RECEIPT + "\nTransfer pending\n", "TRANSFER_PENDING");
  assertFlag(RECEIPT + "\nTransfer failed\n", "TRANSFER_STATUS_INVALID");
  assertFlag(RECEIPT + "\nSent via BPI\n", "METHOD_MISMATCH");
  assertFlag(
    RECEIPT.replace(/InstaPay/g, "PESONet"),
    "INSTAPAY_QRPH_UNREADABLE",
  );
});

Deno.test("Maya verifier rejects stale, premature, conflicting, and wrong-date time", () => {
  assertFlag(
    RECEIPT.replace("12:02 pm", "12:30 pm"),
    "TIME_EXPIRED",
  );
  assertFlag(
    RECEIPT.replace("12:02 pm", "11:50 am"),
    "TIME_FUTURE",
  );
  assertFlag(
    RECEIPT.replace("Sep 5, 2026", "Sep 4, 2026"),
    "DATE_NOT_TODAY",
  );
  assertFlag(
    RECEIPT.replace(
      "Sep 5, 2026, 12:02 pm",
      "Sep 5, 2026, 12:02 pm\nSep 5, 2026, 12:03 pm",
    ),
    "TIME_UNREADABLE",
  );
});

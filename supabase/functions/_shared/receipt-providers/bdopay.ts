import {
  extractReceiptAmount,
  type ReceiptAmountExtraction,
} from "../receipt-amount.ts";
import type {
  BankReceiptTimestamp,
  ReceiptDedupeKey,
  ReceiptVerificationContext,
  TypedReferenceMatch,
} from "./bank-to-gcash.ts";

export type BdoPayReferenceField = {
  value: string | null;
  raw: string | null;
  receiptDate: string | null;
  lineIndex: number | null;
  confidence: "high" | "low";
  typedMatch: TypedReferenceMatch;
};

export type BdoPayInvoiceField = {
  value: string | null;
  raw: string | null;
  lineIndex: number | null;
  confidence: "high" | "low";
};

export type BdoPayRecipientField = {
  nameRaw: string | null;
  nameNormalized: string | null;
  destinationRaw: string | null;
  accountRaw: string | null;
  accountNormalized: string | null;
  accountMasked: boolean;
  lineIndex: number | null;
};

export type BdoPayReceiptParse = {
  provider: "bdopay";
  destinationProvider: "gcash";
  parserVersion: "bdopay_to_gcash_v1";
  reference: BdoPayReferenceField;
  invoice: BdoPayInvoiceField;
  amount: ReceiptAmountExtraction;
  timestamp: BankReceiptTimestamp;
  recipient: BdoPayRecipientField;
  indicators: {
    providerBrand: boolean;
    competingProviderBrand: boolean;
    transferSuccess: boolean;
    sendMoney: boolean;
    destinationGcash: boolean;
    instaPay: boolean;
    referenceLabel: boolean;
    invoiceLabel: boolean;
    matchingAmountDisplays: boolean;
  };
  issues: string[];
};

export type BdoPayRecipientComparison = {
  name: "exact" | "mismatch" | "missing" | "not_configured";
  account:
    | "exact"
    | "suffix_exact"
    | "suffix_ocr_compatible"
    | "mismatch"
    | "missing"
    | "not_configured";
};

export type BdoPayReceiptVerificationEvidence = {
  provider: "bdopay";
  destinationProvider: "gcash";
  parserVersion: "bdopay_to_gcash_v1";
  flags: string[];
  recipientComparison: BdoPayRecipientComparison;
  dedupeKeys: ReceiptDedupeKey[];
};

type BdoPayVerificationContext = ReceiptVerificationContext & {
  expectedRecipientAccount?: string;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function linesOf(rawText: string): string[] {
  return String(rawText || "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function receiptBodyLines(rawText: string): string[] {
  const lines = linesOf(rawText);
  const bodyStart = lines.findIndex((line) => /^sent\s*!?$/i.test(line));
  return bodyStart >= 0 ? lines.slice(bodyStart) : [];
}

export function normalizeBdoPayReference(value: string): string {
  return String(value || "").normalize("NFKC").toUpperCase().replace(
    /[^A-Z0-9]/g,
    "",
  );
}

export function normalizeBdoPayRecipient(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function validDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function validReference(value: string): boolean {
  const normalized = normalizeBdoPayReference(value);
  if (!/^BN\d{16}$/.test(normalized)) return false;
  const year = Number(normalized.slice(2, 6));
  const month = Number(normalized.slice(6, 8));
  const day = Number(normalized.slice(8, 10));
  return validDateParts(year, month, day);
}

function referenceReceiptDate(value: string | null): string | null {
  const normalized = normalizeBdoPayReference(value || "");
  if (!validReference(normalized)) return null;
  return `${normalized.slice(2, 6)}-${normalized.slice(6, 8)}-${
    normalized.slice(8, 10)
  }`;
}

function typedReferenceMatch(
  observed: string | null,
  typedReference: string,
): TypedReferenceMatch {
  const typed = normalizeBdoPayReference(typedReference);
  if (!typed) return "not_provided";
  if (!validReference(typed)) return "typed_invalid";
  if (!observed) return "ocr_missing";
  return observed === typed ? "match" : "mismatch";
}

function parseReference(
  lines: string[],
  typedReference: string,
): { field: BdoPayReferenceField; ambiguous: boolean } {
  const candidates: Array<{ value: string; raw: string; lineIndex: number }> =
    [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(
      /^reference\s*(?:no\.?|number|#)\s*[:#\-–—]?\s*(.*)$/i,
    );
    if (!match) return;
    const nearby = [String(match[1] || ""), String(lines[lineIndex + 1] || "")];
    for (const raw of nearby) {
      const token = raw.match(/\bBN[\s-]*\d{8}[\s-]*\d{8}\b/i)?.[0] || "";
      const value = normalizeBdoPayReference(token);
      if (validReference(value)) {
        candidates.push({ value, raw: token, lineIndex });
        break;
      }
    }
  });
  const unique = [
    ...new Map(candidates.map((item) => [item.value, item])).values(),
  ];
  const selected = unique.length === 1 ? unique[0] : null;
  return {
    ambiguous: unique.length > 1,
    field: {
      value: selected?.value || null,
      raw: selected?.raw || null,
      receiptDate: referenceReceiptDate(selected?.value || null),
      lineIndex: selected?.lineIndex ?? null,
      confidence: selected ? "high" : "low",
      typedMatch: typedReferenceMatch(
        selected?.value || null,
        typedReference,
      ),
    },
  };
}

function parseInvoice(
  lines: string[],
): { field: BdoPayInvoiceField; ambiguous: boolean } {
  const candidates: Array<{ value: string; raw: string; lineIndex: number }> =
    [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(
      /^invoice\s*(?:no\.?|number|#)\s*[:#\-–—]?\s*(.*)$/i,
    );
    if (!match) return;
    const nearby = [String(match[1] || ""), String(lines[lineIndex + 1] || "")];
    for (const raw of nearby) {
      const token = raw.match(/^\s*(\d{4,20})\s*$/)?.[1] || "";
      if (token) {
        candidates.push({ value: token, raw: token, lineIndex });
        break;
      }
    }
  });
  const unique = [
    ...new Map(candidates.map((item) => [item.value, item])).values(),
  ];
  const selected = unique.length === 1 ? unique[0] : null;
  return {
    ambiguous: unique.length > 1,
    field: {
      value: selected?.value || null,
      raw: selected?.raw || null,
      lineIndex: selected?.lineIndex ?? null,
      confidence: selected ? "high" : "low",
    },
  };
}

function parseTimestamp(lines: string[]): BankReceiptTimestamp {
  const pattern =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2})\s*[:;.]\s*(\d{2})(?:\s*[:;. ]\s*(\d{2}))?\s*(AM|PM)\b/i;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const combined = `${lines[lineIndex]} ${lines[lineIndex + 1] || ""}`;
    const match = combined.match(pattern);
    if (!match) continue;
    const month = MONTHS[match[1].toLowerCase()] || 0;
    const day = Number(match[2]);
    const year = Number(match[3]);
    let hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    const meridiem = match[7].toUpperCase();
    if (
      !validDateParts(year, month, day) || hour < 1 || hour > 12 ||
      minute > 59 || second > 59
    ) {
      return {
        raw: match[0],
        date: null,
        time24: null,
        zone: "Asia/Manila",
        instant: null,
        completeness: "invalid",
        lineIndex,
      };
    }
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (meridiem === "PM" && hour !== 12) hour += 12;
    const date = [
      year.toString().padStart(4, "0"),
      month.toString().padStart(2, "0"),
      day.toString().padStart(2, "0"),
    ].join("-");
    const time24 = `${hour.toString().padStart(2, "0")}:${
      minute.toString().padStart(2, "0")
    }`;
    const instant = new Date(
      `${date}T${time24}:${second.toString().padStart(2, "0")}+08:00`,
    );
    return {
      raw: match[0],
      date,
      time24,
      zone: "Asia/Manila",
      instant: Number.isNaN(instant.getTime()) ? null : instant.toISOString(),
      completeness: Number.isNaN(instant.getTime()) ? "invalid" : "date_time",
      lineIndex,
    };
  }
  return {
    raw: null,
    date: null,
    time24: null,
    zone: "Asia/Manila",
    instant: null,
    completeness: "missing",
    lineIndex: null,
  };
}

function validDestinationAccount(value: string): boolean {
  return /^[A-Z0-9]{10,40}$/.test(value) && /[A-Z]/.test(value) &&
    /\d/.test(value);
}

function parseRecipient(lines: string[]): BdoPayRecipientField {
  const toIndex = lines.findIndex((line) =>
    /^to(?:\s*:)?(?:\s+.*)?$/i.test(line)
  );
  if (toIndex < 0) {
    return {
      nameRaw: null,
      nameNormalized: null,
      destinationRaw: null,
      accountRaw: null,
      accountNormalized: null,
      accountMasked: false,
      lineIndex: null,
    };
  }
  const inlineName = lines[toIndex].replace(/^to(?:\s*:)?\s*/i, "").trim();
  const endIndex = lines.findIndex((line, index) =>
    index > toIndex && /^from(?:\s*:)?(?:\s+.*)?$/i.test(line)
  );
  const block = lines.slice(
    toIndex + 1,
    endIndex > toIndex ? endIndex : toIndex + 7,
  );
  // Vision may emit both column labels before either value: To / From / recipient.
  // Only consume the first value after a bare adjacent From label, and only when
  // followed by the BDO sender account-type row; never search the sender block.
  const reorderedCompact = endIndex === toIndex + 1 &&
      /^from\s*:?$/i.test(lines[endIndex]) &&
      /^REGULAR SA-INDIVIDUAL$/i.test(lines[endIndex + 2] || "")
    ? [lines[endIndex + 1] || ""]
    : [];
  const destinationOffset = block.findIndex((line) =>
    /\bg-?xchange\b/i.test(line) && /\bgcash\b/i.test(line)
  );
  let nameRaw: string | null = inlineName ||
    (destinationOffset > 0 ? String(block[destinationOffset - 1] || "") : "") ||
    null;
  let destinationRaw = destinationOffset >= 0 ? block[destinationOffset] : null;
  let accountRaw = destinationOffset >= 0
    ? block.slice(destinationOffset + 1).find((line) => {
      const normalized = normalizeBdoPayRecipient(line);
      return validDestinationAccount(normalized);
    }) || null
    : null;
  let accountMasked = false;

  if (destinationOffset < 0) {
    const compactCandidates = [inlineName, ...block, ...reorderedCompact]
      .map((raw) => {
        const match = String(raw || "").match(
          /^(.+?)\s*(?:\.{2,}|…+|[•·]{2,})\s*([a-z0-9]{4})$/i,
        );
        if (!match) return null;
        const name = String(match[1] || "").trim();
        const suffix = String(match[2] || "").toUpperCase();
        return normalizeBdoPayRecipient(name) && suffix
          ? { raw: String(raw), name, suffix }
          : null;
      })
      .filter((candidate): candidate is {
        raw: string;
        name: string;
        suffix: string;
      } => !!candidate);
    const uniqueCompact = [
      ...new Map(
        compactCandidates.map((candidate) => [
          `${normalizeBdoPayRecipient(candidate.name)}:${candidate.suffix}`,
          candidate,
        ]),
      ).values(),
    ];
    const compact = uniqueCompact.length === 1 ? uniqueCompact[0] : null;
    if (compact) {
      nameRaw = compact.name;
      destinationRaw = compact.raw;
      accountRaw = compact.suffix;
      accountMasked = true;
    }
  }
  return {
    nameRaw,
    nameNormalized: nameRaw ? normalizeBdoPayRecipient(nameRaw) : null,
    destinationRaw,
    accountRaw,
    accountNormalized: accountRaw ? normalizeBdoPayRecipient(accountRaw) : null,
    accountMasked,
    lineIndex: nameRaw ? toIndex : null,
  };
}

function failClosedOnConflictingAmounts(
  amount: ReceiptAmountExtraction,
): ReceiptAmountExtraction {
  const principalAmounts = new Set(
    amount.candidates
      .filter((candidate) => !candidate.excluded)
      .map((candidate) => candidate.amount),
  );
  if (principalAmounts.size <= 1) return amount;
  return {
    ...amount,
    amount: null,
    reliable: false,
    ambiguous: true,
    evidence: [],
    selectedCandidate: null,
    reason: "ambiguous",
  };
}

function compareRecipient(
  parsed: BdoPayRecipientField,
  expectedNameRaw: string,
  expectedAccountRaw: string,
): BdoPayRecipientComparison {
  const expectedName = normalizeBdoPayRecipient(expectedNameRaw);
  const expectedAccount = normalizeBdoPayRecipient(expectedAccountRaw);
  const observedSuffix = parsed.accountNormalized || "";
  const expectedSuffix = expectedAccount.slice(-4);
  const suffixDifferences = [...observedSuffix].filter((char, i) =>
    char !== expectedSuffix[i]
  ).length;
  const suffixOcrCompatible = parsed.accountMasked && observedSuffix.length === 4 &&
    validDestinationAccount(expectedAccount) &&
    !!expectedName && parsed.nameNormalized === expectedName &&
    suffixDifferences === 1 &&
    observedSuffix.replace(/O/g, "0") === expectedSuffix.replace(/O/g, "0");
  return {
    name: !expectedName
      ? "not_configured"
      : !parsed.nameNormalized
      ? "missing"
      : parsed.nameNormalized === expectedName
      ? "exact"
      : "mismatch",
    account: !expectedAccount
      ? "not_configured"
      : !parsed.accountNormalized
      ? "missing"
      : parsed.accountMasked && parsed.accountNormalized.length === 4 &&
          validDestinationAccount(expectedAccount) &&
          expectedAccount.endsWith(parsed.accountNormalized)
      ? "suffix_exact"
      : suffixOcrCompatible
      ? "suffix_ocr_compatible"
      : parsed.accountNormalized === expectedAccount
      ? "exact"
      : "mismatch",
  };
}

function addUnique(flags: string[], flag: string): void {
  if (!flags.includes(flag)) flags.push(flag);
}

export function parseBdoPayToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): BdoPayReceiptParse {
  const lines = receiptBodyLines(rawText);
  const text = lines.join("\n");
  const referenceResult = parseReference(lines, options.typedReference || "");
  const invoiceResult = parseInvoice(lines);
  const amount = failClosedOnConflictingAmounts(
    extractReceiptAmount(text, { provider: "bdopay" }),
  );
  const amountLineCount = amount.amount == null ? 0 : new Set(
    amount.candidates
      .filter((candidate) =>
        !candidate.excluded && candidate.amount === amount.amount
      )
      .map((candidate) => candidate.lineIndex),
  ).size;
  const timestamp = parseTimestamp(lines);
  const recipient = parseRecipient(lines);
  const referenceLabel = lines.some((line) =>
    /^reference\s*(?:no\.?|number|#)\b/i.test(line)
  );
  const invoiceLabel = lines.some((line) =>
    /^invoice\s*(?:no\.?|number|#)\b/i.test(line)
  );
  const providerBrand = /\bbdo\s*pay\b/i.test(text) ||
    /\bthank\s+you\s+for\s+using\s+bdo\b/i.test(text) ||
    (!!referenceResult.field.value && referenceLabel && invoiceLabel);
  const failureStatus =
    /\b(?:failed|unsuccessful|declined|cancelled|canceled|reversed|pending|processing)\b/i
      .test(text);
  const issues: string[] = [];
  if (referenceResult.ambiguous) issues.push("AMBIGUOUS_REFERENCE");
  if (!referenceResult.field.value) issues.push("REFERENCE_MISSING");
  if (invoiceResult.ambiguous) issues.push("AMBIGUOUS_INVOICE");
  if (!invoiceResult.field.value) issues.push("INVOICE_MISSING");
  if (amount.amount == null) issues.push("AMOUNT_MISSING");
  if (!amount.reliable || amount.ambiguous) issues.push("AMOUNT_UNRELIABLE");
  if (amountLineCount < 2) issues.push("AMOUNT_CONFIRMATION_MISSING");
  if (timestamp.completeness === "missing") issues.push("TIMESTAMP_MISSING");
  if (timestamp.completeness === "invalid") issues.push("TIMESTAMP_INVALID");
  if (!recipient.nameNormalized) issues.push("RECIPIENT_NAME_MISSING");
  if (!recipient.accountNormalized) issues.push("RECIPIENT_ACCOUNT_MISSING");
  return {
    provider: "bdopay",
    destinationProvider: "gcash",
    parserVersion: "bdopay_to_gcash_v1",
    reference: referenceResult.field,
    invoice: invoiceResult.field,
    amount,
    timestamp,
    recipient,
    indicators: {
      providerBrand,
      competingProviderBrand:
        /\bsent\s+via\s+(?:gcash|bpi|maya|gotyme|go\s*tyme|maribank|mari\s*bank)\b/i
          .test(text) || /\btransfer\s+successful!?\b/i.test(text),
      transferSuccess: !failureStatus &&
        lines.some((line) => /^sent\s*!?$/i.test(line)),
      sendMoney: /\bsend\s+money\b/i.test(text),
      destinationGcash: /\bg-?xchange\b/i.test(text) && /\bgcash\b/i.test(text),
      instaPay: /\binsta\s*pay\b/i.test(text),
      referenceLabel,
      invoiceLabel,
      matchingAmountDisplays: amountLineCount >= 2,
    },
    issues,
  };
}

export function verifyBdoPayToGcashReceipt(
  parsed: BdoPayReceiptParse,
  context: BdoPayVerificationContext,
): BdoPayReceiptVerificationEvidence {
  const flags: string[] = [];
  const recipientComparison = compareRecipient(
    parsed.recipient,
    context.expectedRecipientName || "",
    context.expectedRecipientAccount || "",
  );
  const bookingStartedAt = context.bookingStartedAt
    ? new Date(context.bookingStartedAt)
    : null;
  const receiptInstant = parsed.timestamp.instant
    ? new Date(parsed.timestamp.instant)
    : null;
  const receiptAgeMinutes = bookingStartedAt && receiptInstant &&
      !Number.isNaN(bookingStartedAt.getTime()) &&
      !Number.isNaN(receiptInstant.getTime())
    ? (receiptInstant.getTime() - bookingStartedAt.getTime()) / 60000
    : null;
  const amountMatches = context.pricingAvailable &&
    context.expectedAmount != null && parsed.amount.amount != null &&
    parsed.amount.reliable && !parsed.amount.ambiguous &&
    parsed.indicators.matchingAmountDisplays &&
    Math.abs(parsed.amount.amount - context.expectedAmount) <=
      context.amountTolerance;
  const timestampMatches = parsed.timestamp.completeness === "date_time" &&
    !!parsed.timestamp.date &&
    (!context.bookingStartedDate ||
      parsed.timestamp.date === context.bookingStartedDate) &&
    (!parsed.reference.receiptDate ||
      parsed.reference.receiptDate === parsed.timestamp.date) &&
    receiptAgeMinutes != null &&
    receiptAgeMinutes >= -context.earlyToleranceMinutes &&
    receiptAgeMinutes <= context.paymentWindowMinutes;
  const compactStructuralEvidence = recipientComparison.name === "exact" &&
    ["suffix_exact", "suffix_ocr_compatible"].includes(recipientComparison.account) &&
    parsed.indicators.providerBrand &&
    !parsed.indicators.competingProviderBrand &&
    parsed.indicators.transferSuccess &&
    parsed.indicators.sendMoney &&
    parsed.indicators.referenceLabel &&
    parsed.reference.confidence === "high" &&
    parsed.reference.typedMatch === "match" &&
    parsed.indicators.invoiceLabel &&
    parsed.invoice.confidence === "high" &&
    amountMatches && timestampMatches && parsed.issues.length === 0;
  if (recipientComparison.account === "suffix_ocr_compatible" && !compactStructuralEvidence) {
    addUnique(flags, "RECEIVER_ACCOUNT_UNREADABLE");
  }
  if (!parsed.indicators.providerBrand) addUnique(flags, "BDO_PAY_UNREADABLE");
  if (parsed.indicators.competingProviderBrand) {
    addUnique(flags, "METHOD_MISMATCH");
  }
  if (!parsed.indicators.transferSuccess || !parsed.indicators.sendMoney) {
    addUnique(flags, "TRANSFER_STATUS_UNREADABLE");
  }
  if (!parsed.indicators.destinationGcash && !compactStructuralEvidence) {
    addUnique(flags, "GXI_DESTINATION_UNREADABLE");
  }
  if (!parsed.indicators.instaPay && !compactStructuralEvidence) {
    addUnique(flags, "INSTAPAY_QRPH_UNREADABLE");
  }
  if (!parsed.indicators.referenceLabel) {
    addUnique(flags, "REF_LABEL_UNREADABLE");
  }
  if (!parsed.indicators.invoiceLabel || !parsed.invoice.value) {
    addUnique(flags, "INVOICE_UNREADABLE");
  }

  if (parsed.reference.typedMatch === "typed_invalid") {
    addUnique(flags, "REF_FORMAT_INVALID");
  }
  if (!parsed.reference.value) addUnique(flags, "REF_UNREADABLE");
  if (parsed.reference.typedMatch === "mismatch") {
    addUnique(flags, "REF_MISMATCH");
  }

  if (!context.pricingAvailable || context.expectedAmount == null) {
    addUnique(flags, "PRICING_UNAVAILABLE");
  } else if (
    parsed.amount.amount == null || !parsed.amount.reliable ||
    parsed.amount.ambiguous
  ) {
    addUnique(flags, "AMOUNT_UNREADABLE");
  } else if (!parsed.indicators.matchingAmountDisplays) {
    addUnique(flags, "AMOUNT_CONFIRMATION_UNREADABLE");
  } else if (
    Math.abs(parsed.amount.amount - context.expectedAmount) >
      context.amountTolerance
  ) {
    addUnique(flags, "AMOUNT_MISMATCH");
  }

  if (!parsed.timestamp.date) addUnique(flags, "DATE_UNREADABLE");
  else {
    if (
      context.bookingStartedDate &&
      parsed.timestamp.date !== context.bookingStartedDate
    ) addUnique(flags, "DATE_NOT_TODAY");
    if (
      parsed.reference.receiptDate &&
      parsed.reference.receiptDate !== parsed.timestamp.date
    ) addUnique(flags, "REF_DATE_MISMATCH");
  }
  if (
    !bookingStartedAt || Number.isNaN(bookingStartedAt.getTime()) ||
    !receiptInstant || Number.isNaN(receiptInstant.getTime())
  ) {
    addUnique(flags, "TIME_UNREADABLE");
  } else {
    const ageMinutes = (receiptInstant.getTime() - bookingStartedAt.getTime()) /
      60000;
    if (ageMinutes < -context.earlyToleranceMinutes) {
      addUnique(flags, "TIME_FUTURE");
    } else if (ageMinutes > context.paymentWindowMinutes) {
      addUnique(flags, "TIME_EXPIRED");
    }
  }

  if (recipientComparison.name === "not_configured") {
    addUnique(flags, "MERCHANT_CONFIG_MISSING");
  } else if (recipientComparison.name === "missing") {
    addUnique(flags, "RECEIVER_NAME_UNREADABLE");
  } else if (recipientComparison.name === "mismatch") {
    addUnique(flags, "RECEIVER_NAME_MISMATCH");
  }
  if (recipientComparison.account === "not_configured") {
    addUnique(flags, "MERCHANT_CONFIG_MISSING");
  } else if (recipientComparison.account === "missing") {
    addUnique(flags, "RECEIVER_ACCOUNT_UNREADABLE");
  } else if (recipientComparison.account === "mismatch") {
    addUnique(flags, "RECEIVER_ACCOUNT_MISMATCH");
  }

  const dedupeKeys: ReceiptDedupeKey[] = [];
  if (parsed.reference.value) {
    dedupeKeys.push({
      key: `bdopay:${parsed.reference.value}`,
      providerKey: "bdopay",
      duplicateFlag: "DUPLICATE_REF",
    });
  }
  if (parsed.invoice.value) {
    dedupeKeys.push({
      key: `bdopay_invoice:${parsed.invoice.value}`,
      providerKey: "bdopay_invoice",
      duplicateFlag: "DUPLICATE_INVOICE",
    });
  }
  return {
    provider: "bdopay",
    destinationProvider: "gcash",
    parserVersion: parsed.parserVersion,
    flags,
    recipientComparison,
    dedupeKeys,
  };
}

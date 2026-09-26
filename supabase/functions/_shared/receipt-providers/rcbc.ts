import { extractReceiptAmount } from "../receipt-amount.ts";
import { parseBpiToRcbcReceipt, verifyBpiToRcbcReceipt } from "./bpi-rcbc.ts";
import { parseGotymeToRcbcReceipt, verifyGotymeToRcbcReceipt } from "./gotyme-rcbc.ts";
import {
  type BankReceiptVerificationEvidence,
  type BankToGcashReceiptParse,
  parseTimestamp,
  type ReceiptDedupeKey,
  type ReceiptVerificationContext,
} from "./bank-to-gcash.ts";

export type RcbcLayout =
  | "gcash_bank"
  | "bpi_bank"
  | "maribank_bank"
  | "instapay_details"
  | "gotyme_bank"
  | "unsupported";
export type RcbcReceipt =
  & Omit<
    BankToGcashReceiptParse,
    "provider" | "destinationProvider" | "parserVersion"
  >
  & {
    provider: "rcbc";
    destinationProvider: "rcbc";
    parserVersion: "rcbc_incoming_v1";
    layout: RcbcLayout;
    references: string[];
    canonicalReference: string | null;
    destinationBank: string | null;
    sourceParserVersion?: "gotyme_to_rcbc_v1" | "bpi_to_rcbc_v1";
    traceReference?: string | null;
  };
export type RcbcEvidence =
  & Omit<
    BankReceiptVerificationEvidence,
    "provider" | "destinationProvider" | "parserVersion"
  >
  & {
    provider: "rcbc";
    destinationProvider: "rcbc";
    parserVersion: "rcbc_incoming_v1";
  };
const compact = (s: string) =>
  s.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
const MONEY = /^(?:(?:PHP|P|₱)\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/i;
const BANK = /^RCBC\s*\/\s*DiskarTech$/i;
const LABELS = [
  "InstaPay Reference Number",
  "InstaPay Invoice No.",
  "Confirmation Number",
  "Confirmation No.",
  "Transaction Ref. No.",
  "Transaction Ref No.",
  "Transaction Date & Time",
  "Transfer Amount",
  "Transfer amount",
  "Transfer Fee",
  "Total Amount",
  "Account Name",
  "Account No.",
  "Transfer Method",
  "Receipt sent to",
  "Reference Number",
  "Transfer Details",
  "Request Submitted",
  "Transfer to",
  "Sent Via",
  "Ref No.",
  "Bank",
  "+Fee",
  "Total",
  "Date",
  "Status",
  "Amount",
  "Fee",
  "From",
  "To",
];
const key = (s: string) => s.toLowerCase().replace(/[:.]/g, "").trim();
const labelKeys = new Set(LABELS.map(key));
function linesOf(text: string): string[] {
  return text.normalize("NFKC").split(/\r?\n/).map((x) =>
    x.trim().replace(/\s+/g, " ")
  ).filter(Boolean).flatMap((line) => {
    if (/^Bank Transfer Complete$/i.test(line)) return [line];
    for (const label of LABELS) {
      if (line.toLowerCase().startsWith(label.toLowerCase() + " ")) {
        return [label, line.slice(label.length).trim()];
      }
    }
    return [line];
  });
}
function block(lines: string[], label: string): string[] {
  const indices = lines.flatMap((s, i) => key(s) === key(label) ? [i] : []);
  if (indices.length !== 1) return [];
  const start = indices[0] + 1;
  const end = lines.findIndex((s, i) => i >= start && labelKeys.has(key(s)));
  return lines.slice(start, end < 0 ? lines.length : end);
}
function singleMoney(values: string[]): string | null {
  return values.length === 1 && MONEY.test(values[0]) ? values[0] : null;
}
function ref(values: string[], min = 6): string | null {
  return values.length === 1 && new RegExp(`^[0-9]{${min},20}$`).test(values[0])
    ? values[0]
    : null;
}
function timestamp(lines: string[]) {
  // Only a full transaction date is eligible. The phone's status-bar clock is ignored.
  const dates = lines.filter((s) =>
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i.test(s) &&
    /\b20\d{2}\b/.test(s)
  );
  const unique = [...new Set(dates)];
  if (unique.length !== 1) return parseTimestamp([]);
  const normalized = unique[0].replace(/[;|]/g, " ").replace(
    /(\d{1,2}:\d{2}):\d{2}/,
    "$1",
  );
  return parseTimestamp(["Date " + normalized]);
}
type Fields = {
  bank: string | null;
  name: string | null;
  account: string | null;
  amount: string | null;
  references: string[];
  dateLines: string[];
  success: boolean;
  rail: string | null;
  issues: string[];
};
const empty = (): Fields => ({
  bank: null,
  name: null,
  account: null,
  amount: null,
  references: [],
  dateLines: [],
  success: false,
  rail: null,
  issues: [],
});

function gcashBank(lines: string[], raw: string): Fields {
  const f = empty();
  f.success = /\bBank Transfer Complete\b/i.test(raw) &&
    /\bSent via GCash\b/i.test(raw);
  f.bank = block(lines, "Bank")[0] || null;
  f.account = block(lines, "Account No.")[0] || null;
  f.name = block(lines, "Account Name").join(" ") || null;
  f.amount = singleMoney(block(lines, "Transfer Amount"));
  let fee = singleMoney(block(lines, "+Fee"));
  let total = singleMoney(block(lines, "Total"));
  let reference = ref(block(lines, "Ref No."), 13);
  f.rail = ref(block(lines, "InstaPay Invoice No."));
  // Google Vision may emit the entire left label column before the right column.
  // Recover only this exact known sequence, with all three money fields and their sum.
  const sequence = [
    "Bank",
    "Account No.",
    "Account Name",
    "Transfer Method",
    "Receipt sent to",
    "Transfer Amount",
    "+Fee",
    "Total",
  ];
  const at = lines.findIndex((_, i) =>
    sequence.every((v, j) => key(lines[i + j] || "") === key(v))
  );
  if (at >= 0) {
    const end = lines.findIndex((s, i) => i > at + 7 && key(s) === "date");
    const values = lines.slice(at + 8, end < 0 ? at + 8 : end);
    const railIndex = values.findIndex((s) => /^InstaPay$/i.test(s));
    if (
      railIndex >= 3 && railIndex <= 4 && values.length === railIndex + 5 &&
      /@/.test(values[railIndex + 1])
    ) {
      f.bank = values[0];
      f.account = values[1];
      f.name = values.slice(2, railIndex).join(" ");
      f.amount = singleMoney([values[railIndex + 2]]);
      fee = singleMoney([values[railIndex + 3]]);
      total = singleMoney([values[railIndex + 4]]);
    } else f.issues.push("RCBC_LAYOUT_UNREADABLE");
  }
  const dateSeq = ["Date", "InstaPay Invoice No.", "Ref No."];
  const d = lines.findIndex((_, i) =>
    dateSeq.every((v, j) => key(lines[i + j] || "") === key(v))
  );
  if (d >= 0) {
    f.rail = ref([lines[d + 4] || ""]);
    reference = ref([lines[d + 5] || ""], 13);
    f.dateLines = [lines[d + 3] || ""];
  } else f.dateLines = block(lines, "Date");
  f.references = reference ? [reference] : [];
  const num = (s: string | null) =>
    s ? Number(s.match(MONEY)?.[1].replace(/,/g, "")) : NaN;
  if (
    ![f.amount, fee, total].every(Boolean) ||
    Math.abs(num(f.amount) + num(fee) - num(total)) > 0.001
  ) f.issues.push("AMOUNT_CONFLICT");
  if (!/\bInstaPay\b/i.test(raw) || !f.rail) {
    f.issues.push("INSTAPAY_REF_UNREADABLE");
  }
  return f;
}
function maribankBank(lines: string[], raw: string): Fields {
  const f = empty();
  const banks = lines.flatMap((s, i) => BANK.test(s) ? [i] : []);
  if (banks.length === 1) {
    const i = banks[0];
    f.bank = lines[i];
    f.name = lines[i - 1];
    f.account = lines[i + 1]?.replace(/^Acct\.\s*No\.:?\s*/i, "") || null;
  }
  f.amount = singleMoney(block(lines, "Transfer Amount"));
  let reference = ref(block(lines, "Reference Number"));
  // This MariBank export places labels in one OCR column; only accept the
  // exact money/fee/total/reference/rail sequence after the recipient account.
  if (!f.amount && banks.length === 1) {
    const i = banks[0] + 2;
    const v = lines.slice(i, i + 5);
    if (
      v.length === 5 && MONEY.test(v[0]) &&
      (/^(FREE|PHP 0\.00)$/i.test(v[1])) && MONEY.test(v[2]) &&
      /^\d{6,20}$/.test(v[3]) && /^insta(?:Pay|Fay)$/i.test(v[4])
    ) {
      f.amount = v[0];
      reference = v[3];
      if (v[0].match(MONEY)?.[1] !== v[2].match(MONEY)?.[1]) {
        f.issues.push("AMOUNT_CONFLICT");
      }
    }
  }
  f.references = reference ? [reference] : [];
  f.rail = reference;
  f.dateLines = lines.filter((s) =>
    /^\d{1,2} [A-Za-z]+ 20\d{2},? \d{1,2}:\d{2}$/.test(s)
  );
  f.success = /\bTransaction Receipt\b/i.test(raw) &&
    /Receipt generated from MariBank app/i.test(raw) &&
    /\bRealtime\b/i.test(raw) && /insta(?:Pay|Fay)/i.test(raw);
  return f;
}
function instapayDetails(lines: string[], raw: string): Fields {
  const f = empty(), to = block(lines, "To");
  f.name = to[0] || null;
  f.bank = to[1] || null;
  f.account = to[2] || null;
  if (to.length !== 3) f.issues.push("RCBC_RECIPIENT_LAYOUT_UNREADABLE");
  f.amount = singleMoney(block(lines, "Amount"));
  const reference = ref(block(lines, "InstaPay Reference Number"));
  f.references = reference ? [reference] : [];
  f.rail = reference;
  const status = block(lines, "Status");
  f.dateLines = status.filter((s) => /\b20\d{2}\b/.test(s));
  f.success = status.filter((s) => s === "Successful").length === 1 &&
    /Funds have been credited to the\s+recipient\./i.test(raw) &&
    /^insta(?:Pay|Fay)$/i.test(block(lines, "Sent Via")[0] || "");
  return f;
}

export function parseRcbcReceipt(
  raw: string,
  options: { typedReference?: string } = {},
): RcbcReceipt {
  if (/\bGoTyme Bank\b/i.test(raw)) return parseGotymeToRcbcReceipt(raw, options);
  const lines = linesOf(raw);
  const detectors = [
    /Sent via GCash/i.test(raw) && /Bank Transfer Complete/i.test(raw),
    /Sent via BPI/i.test(raw) && /Transfer successful/i.test(raw),
    /MariBank/i.test(raw) && /Transaction Receipt/i.test(raw),
    /Transaction Details/i.test(raw) && /Instapay Reference Number/i.test(raw),
  ];
  const layouts: RcbcLayout[] = [
    "gcash_bank",
    "bpi_bank",
    "maribank_bank",
    "instapay_details",
  ];
  const match = detectors.flatMap((v, i) => v ? [i] : []);
  const layout: RcbcLayout = match.length === 1
    ? layouts[match[0]]
    : "unsupported";
  if (layout === "bpi_bank") return parseBpiToRcbcReceipt(raw, options);
  const f = layout === "gcash_bank"
    ? gcashBank(lines, raw)
    : layout === "maribank_bank"
    ? maribankBank(lines, raw)
    : layout === "instapay_details"
    ? instapayDetails(lines, raw)
    : empty();
  if (layout === "unsupported") f.issues.push("RCBC_FORMAT_UNSUPPORTED");
  // A contradictory status anywhere in the document is never ignored.
  if (
    /\b(pending|processing|failed|unsuccessful|reversed|cancelled|canceled)\b/i
      .test(raw.replace(/Processing Time/gi, ""))
  ) f.success = false;
  const typed = compact(options.typedReference || "");
  const canonical = f.references[0] || null;
  const observed = f.references.find((x) => x === typed) || canonical;
  const amount = extractReceiptAmount(
    f.amount ? `Amount\nPHP ${f.amount.match(MONEY)?.[1]}` : "",
    { provider: "rcbc" },
  );
  return {
    provider: "rcbc",
    destinationProvider: "rcbc",
    parserVersion: "rcbc_incoming_v1",
    layout,
    references: f.references,
    canonicalReference: canonical,
    destinationBank: f.bank,
    reference: {
      value: observed,
      raw: observed,
      source: observed ? "reference_label" : "missing",
      label: "Receipt reference",
      lineIndex: null,
      confidence: observed ? "high" : "low",
      typedMatch: !typed
        ? "not_provided"
        : !observed
        ? "ocr_missing"
        : f.references.includes(typed)
        ? "match"
        : "mismatch",
    },
    railReference: {
      scheme: "instapay",
      value: f.rail,
      raw: f.rail,
      lineIndex: null,
      confidence: f.rail ? "high" : "low",
    },
    amount,
    timestamp: timestamp(f.dateLines),
    recipient: {
      nameRaw: f.name,
      accountRaw: f.account,
      phoneNormalized: null,
      phoneLast4: null,
      phoneVisibility: "missing",
      lineIndex: null,
    },
    indicators: {
      providerBrand: layout !== "unsupported",
      competingProviderBrand: null,
      transferSuccess: f.success,
      destinationGcash: false,
      instaPay: /insta(?:Pay|Fay)/i.test(raw),
      officialTransactionReceipt: layout !== "unsupported",
    },
    issues: f.issues,
  };
}
export function verifyRcbcReceipt(
  r: RcbcReceipt,
  c: ReceiptVerificationContext,
): RcbcEvidence {
  if (r.layout === "bpi_bank") return verifyBpiToRcbcReceipt(r, c);
  if (r.layout === "gotyme_bank") return verifyGotymeToRcbcReceipt(r,c);
  const flags = [...r.issues];
  const expected = compact(c.expectedRecipientNumber || "");
  const actual = (r.recipient.accountRaw || "").replace(/\s/g, "");
  const name = !c.expectedRecipientName
    ? "not_configured"
    : !r.recipient.nameRaw
    ? "missing"
    : compact(r.recipient.nameRaw) === compact(c.expectedRecipientName)
    ? "exact"
    : "mismatch";
  let account: RcbcEvidence["recipientComparison"]["account"] = "missing";
  if (!/^\d{10}$/.test(expected)) account = "not_configured";
  else if (/^\d{10,16}$/.test(actual)) {
    account = actual.replace(/^0+/, "") === expected.replace(/^0+/, "")
      ? "exact"
      : "mismatch";
  } else {
    const m = actual.match(/^[Xx*•.●]+(\d{4,10})$/);
    if (m) account = expected.endsWith(m[1]) ? "suffix_exact" : "mismatch";
  }
  if (!BANK.test(r.destinationBank || "")) {
    flags.push("RCBC_DESTINATION_MISMATCH");
  }
  if (name !== "exact") {
    flags.push(
      name === "not_configured"
        ? "MERCHANT_CONFIG_MISSING"
        : name === "missing"
        ? "RECEIVER_NAME_UNREADABLE"
        : "RECEIVER_NAME_MISMATCH",
    );
  }
  if (!["exact", "suffix_exact"].includes(account)) {
    flags.push(
      account === "not_configured"
        ? "MERCHANT_CONFIG_MISSING"
        : account === "mismatch"
        ? "RECEIVER_ACCOUNT_MISMATCH"
        : "RECEIVER_ACCOUNT_UNREADABLE",
    );
  }
  if (!r.indicators.transferSuccess) flags.push("TRANSFER_STATUS_UNREADABLE");
  if (r.reference.typedMatch !== "match") {
    flags.push(r.reference.value ? "REF_MISMATCH" : "REF_UNREADABLE");
  }
  if (
    !c.pricingAvailable || c.expectedAmount == null || c.expectedAmount <= 0
  ) flags.push("PRICING_UNAVAILABLE");
  else if (
    !r.amount.reliable || r.amount.ambiguous || r.amount.amount == null
  ) flags.push("AMOUNT_UNREADABLE");
  else if (
    Math.round(r.amount.amount * 100) !== Math.round(c.expectedAmount * 100)
  ) flags.push("AMOUNT_MISMATCH");
  const age = (Date.parse(r.timestamp.instant || "") -
    Date.parse(c.bookingStartedAt || "")) / 60000;
  if (!Number.isFinite(age) || r.timestamp.completeness !== "date_time") {
    flags.push("TIME_UNREADABLE");
  } else if (age < -c.earlyToleranceMinutes || age > c.paymentWindowMinutes) {
    flags.push("TIME_EXPIRED");
  }
  const keys: ReceiptDedupeKey[] = [];
  const add = (key: string, providerKey: string) =>
    keys.push({ key, providerKey, duplicateFlag: "DUPLICATE_REF" });
  for (const value of r.references) {
    // Full references also share the source bank's existing identity namespace.
    if (value.length >= 10) {
      add(`rcbc:${value}`, "rcbc");
      if (r.layout === "gcash_bank") add(value, "gcash");
    } else if (r.timestamp.date) {
      add(`rcbc_${r.layout}:${r.timestamp.date}:${value}`, `rcbc_${r.layout}`);
    }
  }
  if (r.railReference.value && r.timestamp.date) {
    add(`rcbc_rail:${r.timestamp.date}:${r.railReference.value}`, "rcbc_rail");
  }
  return {
    provider: "rcbc",
    destinationProvider: "rcbc",
    parserVersion: "rcbc_incoming_v1",
    flags: [...new Set(flags)],
    recipientComparison: { name, account, phone: "missing" },
    dedupeKeys: keys,
  };
}

// RCBC-only critical digit confidence. Whole-image confidence alone can hide an
// uncertain amount/reference/account digit. Never apply this policy to other routes.
export function rcbcCriticalDigitsReadable(
  words: Array<{ text: string; minDigitConfidence: number }>,
  r: RcbcReceipt,
): boolean {
  const parts = words.map((w) => ({
    value: compact(w.text),
    confidence: w.minDigitConfidence,
  }));
  const joined = parts.map((p) => p.value).join("");
  const targets = [
    ...r.references,
    (r.recipient.accountRaw || "").replace(/[^0-9]/g, ""),
    r.amount.amount == null
      ? ""
      : r.amount.amount.toFixed(2).replace(/\D/g, ""),
  ];
  if (!targets.length || targets.some((t) => !t) || !words.length) return false;
  return targets.every((target) => {
    const at = joined.indexOf(target);
    if (at < 0) return false;
    let pos = 0;
    let found = false;
    for (const part of parts) {
      const next = pos + part.value.length;
      if (next > at && pos < at + target.length && /\d/.test(part.value)) {
        found = true;
        if (!Number.isFinite(part.confidence) || part.confidence < .90) {
          return false;
        }
      }
      pos = next;
    }
    return found;
  });
}

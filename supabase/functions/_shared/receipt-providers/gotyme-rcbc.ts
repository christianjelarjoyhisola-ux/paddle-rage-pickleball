import { extractReceiptAmount } from "../receipt-amount.ts";
import {
  parseTimestamp,
  type ReceiptVerificationContext,
} from "./bank-to-gcash.ts";
import type { RcbcEvidence, RcbcReceipt } from "./rcbc.ts";

const BANK = /^Rizal Commercial Banking Corp\.?\s*\(RCBC\)$/i;
const MONEY = /^(?:₱|P|PHP|\$)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/i;
const REFERENCE = /^ITO\d{15}$/;
const LABELS = [
  "To",
  "From",
  "Amount",
  "Fee",
  "Total",
  "Trace ID",
  "Reference No.",
  "Date",
];
const labelKey = (s: string) => s.toLowerCase().replace(/[.:]$/, "");
const isLabel = (s: string) => LABELS.some((l) => labelKey(l) === labelKey(s));
const number = (s: string | undefined) =>
  s?.match(MONEY) ? Number(s.match(MONEY)![1].replace(/,/g, "")) : null;

export function parseGotymeToRcbcReceipt(
  raw: string,
  options: { typedReference?: string } = {},
): RcbcReceipt {
  const issues: string[] = [];
  const lines = raw.normalize("NFKC").split(/\r?\n/).map((s) =>
    s.trim().replace(/\s+/g, " ")
  ).filter(Boolean).flatMap((s) => {
    const label = LABELS.find((l) =>
      s.toLowerCase().startsWith(l.toLowerCase() + " ")
    );
    return label ? [label, s.slice(label.length).trim()] : [s];
  });
  const index = (label: string) => {
    const hits = lines.flatMap((s, i) =>
      labelKey(s) === labelKey(label) ? [i] : []
    );
    return hits.length === 1 ? hits[0] : -1;
  };
  const block = (label: string) => {
    const at = index(label);
    if (at < 0) return [];
    const end = lines.findIndex((s, i) => i > at && isLabel(s));
    return lines.slice(at + 1, end < 0 ? lines.length : end);
  };
  let to = block("To");
  // Vision sometimes places To before the transfer header. Only skip the
  // known header, never scan the sender section for recipient information.
  while (
    to.length &&
    /^(?:Transferred[!.]?|Share|Repeat|Add to favorites|[₱P$]\s*[\d,]+\.\d{2})$/i
      .test(to[0])
  ) to = to.slice(1);
  const accounts = to.flatMap((s, i) =>
    /^(?:[*•●·.xX]+\s*\d{4,10}|\d{10,16})$/.test(s) ? [i] : []
  );
  let name: string | null = null,
    account: string | null = null,
    bank: string | null = null;
  if (accounts.length === 1) {
    const at = accounts[0];
    account = to[at].replace(/\s/g, "");
    // A line containing only stars continues the preceding masked name token.
    name = to.slice(0, at).join(" ").replace(/\s+([*•●·]+)/g, "$1").trim() ||
      null;
    bank = to.slice(at + 1).filter((s) => s !== "=").join(" ");
  } else issues.push("RCBC_RECIPIENT_LAYOUT_UNREADABLE");
  const sender = block("From");
  const source = sender.length >= 3 &&
    /^GoTyme Bank$/i.test(sender.at(-1) || "");
  const amountBlock = block("Amount"), feeBlock = block("Fee");
  const amountValue = amountBlock.length === 1 ? number(amountBlock[0]) : null;
  const feeValue = feeBlock.length === 1 ? number(feeBlock[0]) : null;
  let totalValue = block("Total").length === 1
    ? number(block("Total")[0])
    : null;
  let reference = block("Reference No.").length === 1
    ? block("Reference No.")[0]
    : "";
  let trace = block("Trace ID").length === 1 ? block("Trace ID")[0] : "";
  const dates = block("Date").filter((s) =>
    /^\d{1,2} [A-Za-z]+ 20\d{2} at \d{1,2}:\d{2}(?: [AP]M)$/i.test(s)
  );
  let date = dates.length === 1 ? dates[0] : "";
  // Known column-first export: Total / Trace ID / Reference / Date are read
  // before their four values. Recover only the ordered, bounded value block.
  const totalAt = index("Total");
  if (
    totalAt >= 0 &&
    ["Trace ID", "Reference No.", "Date"].every((l, i) =>
      labelKey(lines[totalAt + i + 1] || "") === labelKey(l)
    )
  ) {
    const tail = lines.slice(totalAt + 4).filter((s) =>
      !/^Get help$|^Instant$|^[>✓]$/i.test(s)
    );
    if (
      tail.length === 4 && number(tail[0]) !== null &&
      /^\d{6}$/.test(tail[1]) && REFERENCE.test(tail[2]) &&
      /^\d{1,2} [A-Za-z]+ 20\d{2} at \d{1,2}:\d{2} [AP]M$/i.test(tail[3])
    ) {
      totalValue = number(tail[0]);
      trace = tail[1];
      reference = tail[2];
      date = tail[3];
    } else issues.push("RCBC_LAYOUT_UNREADABLE");
  }
  if (!REFERENCE.test(reference)) reference = "";
  if (!/^\d{6}$/.test(trace)) {
    trace = "";
    issues.push("GOTYME_RCBC_TRACE_UNREADABLE");
  }
  if (LABELS.some((l) => index(l) < 0)) issues.push("RCBC_LAYOUT_UNREADABLE");
  const headers = lines.flatMap((s, i) =>
    /^Transferred[!.]?$/i.test(s) ? [number(lines[i + 1])] : []
  );
  if (
    amountValue === null || feeValue === null || totalValue === null ||
    Math.round((amountValue + feeValue) * 100) !==
      Math.round(totalValue * 100) ||
    headers.length !== 1 || headers[0] !== amountValue
  ) issues.push("AMOUNT_CONFLICT");
  const success = /^Transferred[!.]?$/im.test(raw) &&
    !/\b(pending|processing|failed|unsuccessful|reversed|cancelled|canceled|USD|EUR)\b/i
      .test(raw);
  const rail = /^insta(?:Pay|Fay)$/im.test(raw) && /^Instant$/im.test(raw);
  if (!source || /\b(?:MariBank|BPI|UnionBank)\b/i.test(raw)) {
    issues.push("GOTYME_RECEIPT_UNREADABLE");
  }
  if (!rail) issues.push("INSTAPAY_UNREADABLE");
  const typed = String(options.typedReference || "").toUpperCase().replace(
    /[^A-Z0-9]/g,
    "",
  );
  const timestamp = parseTimestamp(date ? ["Date " + date] : []);
  return {
    provider: "rcbc",
    destinationProvider: "rcbc",
    parserVersion: "rcbc_incoming_v1",
    layout: "gotyme_bank",
    sourceParserVersion: "gotyme_to_rcbc_v1",
    traceReference: trace || null,
    references: reference ? [reference] : [],
    canonicalReference: reference || null,
    destinationBank: bank,
    reference: {
      value: reference || null,
      raw: reference || null,
      source: reference ? "reference_label" : "missing",
      label: "Reference No.",
      lineIndex: null,
      confidence: reference ? "high" : "low",
      typedMatch: !typed
        ? "not_provided"
        : !reference
        ? "ocr_missing"
        : reference === typed
        ? "match"
        : "mismatch",
    },
    railReference: {
      scheme: "instapay",
      value: reference || null,
      raw: reference || null,
      lineIndex: null,
      confidence: reference ? "high" : "low",
    },
    amount: extractReceiptAmount(
      amountValue === null ? "" : `Amount\nPHP ${amountValue.toFixed(2)}`,
      { provider: "rcbc" },
    ),
    timestamp,
    recipient: {
      nameRaw: name,
      accountRaw: account,
      phoneNormalized: null,
      phoneLast4: null,
      phoneVisibility: "missing",
      lineIndex: null,
    },
    indicators: {
      providerBrand: source,
      competingProviderBrand: null,
      transferSuccess: success,
      destinationGcash: false,
      instaPay: rail,
      officialTransactionReceipt: source && success && rail,
    },
    issues,
  };
}

function compareName(
  actual: string | null,
  expected: string | undefined,
): RcbcEvidence["recipientComparison"]["name"] {
  if (!expected) return "not_configured";
  if (!actual) return "missing";
  const clean = (s: string) =>
    s.normalize("NFKC").toUpperCase().replace(/[.]/g, "").trim().replace(
      /\s+/g,
      " ",
    );
  const a = clean(actual), e = clean(expected);
  if (a === e) return "exact";
  const words = a.split(" "), expectedWords = e.split(" ");
  // Require an unmasked first name and every remaining visible prefix in order.
  // Mask length is not trusted because OCR collapses repeated stars.
  if (
    words.length !== expectedWords.length || words.length < 2 ||
    words[0] !== expectedWords[0] || !/^[A-Z]{2,}$/.test(words[0])
  ) return "mismatch";
  return words.every((w, i) =>
      w === expectedWords[i] ||
      (/^[A-Z]+[*•●·]+$/.test(w) &&
        expectedWords[i].startsWith(w.replace(/[*•●·]+$/, "")))
    )
    ? "masked_compatible"
    : "mismatch";
}

export function verifyGotymeToRcbcReceipt(
  r: RcbcReceipt,
  c: ReceiptVerificationContext,
): RcbcEvidence {
  const flags = [...r.issues],
    name = compareName(r.recipient.nameRaw, c.expectedRecipientName);
  const expected = String(c.expectedRecipientNumber || "").replace(/\s/g, ""),
    actual = r.recipient.accountRaw || "";
  let account: RcbcEvidence["recipientComparison"]["account"] = "missing";
  if (!/^\d{10}$/.test(expected)) account = "not_configured";
  else if (/^\d{10,16}$/.test(actual)) {
    account = actual.replace(/^0+/, "") === expected.replace(/^0+/, "")
      ? "exact"
      : "mismatch";
  } else {
    const m = actual.match(/^[*•●·.xX]+(\d{4,10})$/);
    if (m) account = expected.endsWith(m[1]) ? "suffix_exact" : "mismatch";
  }
  if (!BANK.test(r.destinationBank || "")) {
    flags.push("RCBC_DESTINATION_MISMATCH");
  }
  if (!["exact", "masked_compatible"].includes(name)) {
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
  else if (r.amount.amount == null || !r.amount.reliable) {
    flags.push("AMOUNT_UNREADABLE");
  } else if (
    Math.round(r.amount.amount * 100) !== Math.round(c.expectedAmount * 100)
  ) flags.push("AMOUNT_MISMATCH");
  const age = (Date.parse(r.timestamp.instant || "") -
    Date.parse(c.bookingStartedAt || "")) / 60000;
  if (!Number.isFinite(age) || r.timestamp.completeness !== "date_time") {
    flags.push("TIME_UNREADABLE");
  } else if (age < -c.earlyToleranceMinutes || age > c.paymentWindowMinutes) {
    flags.push("TIME_EXPIRED");
  }
  return {
    provider: "rcbc",
    destinationProvider: "rcbc",
    parserVersion: "rcbc_incoming_v1",
    flags: [...new Set(flags)],
    recipientComparison: { name, account, phone: "missing" },
    dedupeKeys: r.references.flatMap((ref) => [
      {
        key: `rcbc:${ref}`,
        providerKey: "rcbc",
        duplicateFlag: "DUPLICATE_REF",
      },
      {
        key: `gotyme:${ref}`,
        providerKey: "gotyme",
        duplicateFlag: "DUPLICATE_REF",
      },
    ]),
  };
}

import { extractReceiptAmount } from "../receipt-amount.ts";
import {
  parseTimestamp,
  type ReceiptDedupeKey,
  type ReceiptVerificationContext,
} from "./bank-to-gcash.ts";
import type { RcbcEvidence, RcbcReceipt } from "./rcbc.ts";

const compact = (s: string) =>
  s.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
const labels = [
  "Confirmation No.",
  "Transaction Ref. No.",
  "Transfer to",
  "Transfer amount",
  "Fee",
  "Transfer from",
];
const key = (s: string) => s.toLowerCase().replace(/[.:]$/, "").trim();
const money = /^(?:(?:PHP|P|₱)\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})$/i;

export function parseBpiToRcbcReceipt(
  raw: string,
  options: { typedReference?: string } = {},
): RcbcReceipt {
  const lines = raw.normalize("NFKC").split(/\r?\n/).map((s) =>
    s.trim().replace(/\s+/g, " ")
  ).filter(Boolean).flatMap((s) => {
    const label = labels.find((l) =>
      s.toLowerCase().startsWith(l.toLowerCase() + " ")
    );
    return label ? [label, s.slice(label.length).trim()] : [s];
  });
  const block = (label: string) => {
    const hits = lines.flatMap((s, i) => key(s) === key(label) ? [i] : []);
    if (hits.length !== 1) return [];
    const at = hits[0] + 1,
      end = lines.findIndex((s, i) =>
        i >= at && labels.some((l) => key(s) === key(l))
      );
    return lines.slice(at, end < 0 ? lines.length : end);
  };
  // BPI places the next reference label immediately after the confirmation;
  // transaction reference is followed by the source brand before Transfer to.
  const reference = (label: string, min: number) => {
    const values = block(label).filter((s) => !/^Sent via BPI$/i.test(s));
    return values.length === 1 &&
        new RegExp(`^[0-9]{${min},20}$`).test(values[0])
      ? values[0]
      : null;
  };
  const confirmation = reference("Confirmation No.", 10),
    transaction = reference("Transaction Ref. No.", 6);
  const refs = [confirmation, transaction].filter((s): s is string => !!s);
  const typed = compact(options.typedReference || ""),
    selected = refs.find((s) => s === typed) || confirmation || transaction;
  const to = block("Transfer to"), amounts = block("Transfer amount");
  const issues: string[] = [];
  if (to.length !== 3) issues.push("RCBC_RECIPIENT_LAYOUT_UNREADABLE");
  if (!confirmation || !transaction) issues.push("REF_UNREADABLE");
  const dates = lines.filter((s) =>
    /\b20\d{2}\b/.test(s) && /GMT\s*\+8/.test(s)
  );
  const date = dates.length === 1
    ? dates[0].replace(/;/g, " ").replace(/(\d{1,2}:\d{2}):\d{2}/, "$1")
    : "";
  const source = /\bSent via BPI\b/i.test(raw);
  if (/\b(?:GoTyme|MariBank|GCash|UnionBank)\b/i.test(raw)) {
    issues.push("RCBC_FORMAT_UNSUPPORTED");
  }
  const success = /\bTransfer successful!/i.test(raw) && source &&
    !/\b(pending|processing|failed|unsuccessful|reversed|cancelled|canceled)\b/i
      .test(raw);
  const amount = amounts.length === 1 ? amounts[0].match(money)?.[1] : null;
  return {
    provider: "rcbc",
    destinationProvider: "rcbc",
    parserVersion: "rcbc_incoming_v1",
    sourceParserVersion: "bpi_to_rcbc_v1",
    layout: "bpi_bank",
    references: refs,
    canonicalReference: confirmation,
    destinationBank: to[0] || null,
    reference: {
      value: selected || null,
      raw: selected || null,
      source: selected ? "reference_label" : "missing",
      label: "Confirmation / Transaction reference",
      lineIndex: null,
      confidence: selected ? "high" : "low",
      typedMatch: !typed
        ? "not_provided"
        : !selected
        ? "ocr_missing"
        : refs.includes(typed)
        ? "match"
        : "mismatch",
    },
    railReference: {
      scheme: "instapay",
      value: transaction,
      raw: transaction,
      lineIndex: null,
      confidence: transaction ? "high" : "low",
    },
    amount: extractReceiptAmount(amount ? `Amount\nPHP ${amount}` : "", {
      provider: "rcbc",
    }),
    timestamp: parseTimestamp(date ? ["Date " + date] : []),
    recipient: {
      nameRaw: to[1]?.replace(/\s*\(QR Code\)\s*$/i, "") || null,
      accountRaw: to[2] || null,
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
      instaPay: /InstaPay/i.test(raw),
      officialTransactionReceipt: source && success,
    },
    issues,
  };
}

export function verifyBpiToRcbcReceipt(
  r: RcbcReceipt,
  c: ReceiptVerificationContext,
): RcbcEvidence {
  const flags = [...r.issues],
    expected = compact(c.expectedRecipientNumber || ""),
    actual = (r.recipient.accountRaw || "").replace(/\s/g, "");
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
  if (!/^RCBC\s*\/\s*DiskarTech$/i.test(r.destinationBank || "")) {
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
  // Claim both identifiers, regardless of which one the customer entered.
  const keys: ReceiptDedupeKey[] = [];
  const add = (key: string, providerKey: string) =>
    keys.push({ key, providerKey, duplicateFlag: "DUPLICATE_REF" });
  for (const ref of r.references) {
    if (ref.length >= 10) {
      add(`rcbc:${ref}`, "rcbc");
      add(`bpi:${ref}`, "bpi");
    } else if (r.timestamp.date) {
      add(`rcbc_bpi_bank:${r.timestamp.date}:${ref}`, "rcbc_bpi_bank");
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

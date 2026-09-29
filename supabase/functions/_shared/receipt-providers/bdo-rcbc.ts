import { extractReceiptAmount } from "../receipt-amount.ts";
import { parseTimestamp } from "./bank-to-gcash.ts";
import type { RcbcReceipt } from "./rcbc.ts";

// BDO's Sent receipt omits the destination bank. Only the RCBC-selected route
// may use this parser; verification must match the configured recipient's exact
// name AND account suffix. The BDO logo alone never establishes destination.
export function parseBdoToRcbcReceipt(
  raw: string,
  options: { typedReference?: string } = {},
): RcbcReceipt {
  const text = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  const money = "PHP\\s*((?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2})";
  // Anchored to the observed BDO layout, including both amount fields and fee.
  // Sender account text is bounded by From / Created on and never a recipient.
  const pattern = new RegExp(
    "^Sent!\\s+" + money + "\\s+Service Fee\\s+" + money +
      "\\s+Total Amount\\s+" + money +
      "\\s+Send Money\\s+(?:via\\s+insta(?:Pay|Fay)|insta(?:Pay|Fay)\\s+via)" +
      "\\s+To\\s+([A-Z][A-Z .'-]+?)\\s*\\.{3}\\s*(\\d{4})" +
      "\\s+From\\s+([A-Z /-]+)\\s+[*•.●]+\\s*\\d{4}" +
      "\\s+Created on\\s+([A-Za-z]{3} \\d{1,2}, 20\\d{2} \\d{1,2}:\\d{2} [AP]M)" +
      "\\s+Reference no\\.\\s+(BN-\\d{8}-\\d{8})" +
      "\\s+Invoice no\\.\\s+(\\d{6,12})\\s+BDO(?:\\s+\\d{1,3}\\s+Years)?$",
    "i",
  );
  const match = text.match(pattern);
  const issues: string[] = [];
  if (
    !match ||
    /\b(pending|processing|failed|unsuccessful|reversed|cancelled|canceled|GCash|GoTyme|BPI|MariBank|UnionBank)\b/i
      .test(text)
  ) {
    issues.push("RCBC_FORMAT_UNSUPPORTED");
  }
  const cents = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);
  if (match && cents(match[1]) + cents(match[2]) !== cents(match[3])) {
    issues.push("BDO_TOTAL_MISMATCH");
  }
  const reference = match?.[8].replace(/-/g, "").toUpperCase() || null;
  const typed = (options.typedReference || "").toUpperCase().replace(
    /[^A-Z0-9]/g,
    "",
  );
  const timestamp = parseTimestamp(match ? ["Created on", match[7]] : []);
  if (
    reference && reference.slice(2, 10) !== timestamp.date?.replace(/-/g, "")
  ) {
    issues.push("BDO_REFERENCE_DATE_MISMATCH");
  }
  return {
    provider: "rcbc",
    destinationProvider: "rcbc",
    parserVersion: "rcbc_incoming_v1",
    sourceParserVersion: "bdo_to_rcbc_v1",
    layout: "bdo_bank",
    references: reference ? [reference] : [],
    canonicalReference: reference,
    invoiceReference: match?.[9] || null,
    // This receipt does not print a destination bank. Do not fabricate one.
    destinationBank: null,
    reference: {
      value: reference,
      raw: match?.[8] || null,
      source: reference ? "reference_label" : "missing",
      label: "Reference no.",
      lineIndex: null,
      confidence: reference ? "high" : "low",
      typedMatch: !typed
        ? "not_provided"
        : !reference
        ? "ocr_missing"
        : typed === reference
        ? "match"
        : "mismatch",
    },
    railReference: {
      scheme: "instapay",
      value: null,
      raw: null,
      lineIndex: null,
      confidence: "low",
    },
    amount: extractReceiptAmount(match ? `Amount\nPHP ${match[1]}` : "", {
      provider: "rcbc",
    }),
    timestamp,
    recipient: {
      nameRaw: match?.[4].trim() || null,
      accountRaw: match ? `...${match[5]}` : null,
      phoneNormalized: null,
      phoneLast4: null,
      phoneVisibility: "missing",
      lineIndex: null,
    },
    indicators: {
      providerBrand: !!match,
      competingProviderBrand: null,
      transferSuccess: !!match && issues.length === 0,
      destinationGcash: false,
      instaPay: !!match,
      officialTransactionReceipt: !!match,
    },
    issues,
  };
}

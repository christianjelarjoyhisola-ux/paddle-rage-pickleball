import { extractReceiptAmount } from "../receipt-amount.ts";
import {
  type BankToGcashReceiptParse,
  type BankReceiptVerificationEvidence,
  type ReceiptVerificationContext,
  type ReceiptDedupeKey,
  parseTimestamp,
} from "./bank-to-gcash.ts";

const normalize = (value: string) => value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
const LABEL = /^(Reference Number|Status|Sent Via|Instapay Reference Number|To|Amount|From)$/i;

// A dedicated UnionBank layout parser. No customer-entered values supply evidence.
export function parseUnionbankToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): BankToGcashReceiptParse & { provider: "unionbank" } {
  const lines = rawText.normalize("NFKC").split(/\r?\n/)
    .map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean)
    .flatMap(line => {
      const match = line.match(/^(Instapay Reference Number|Reference Number|Status|Sent Via|To|Amount|From)\s*:?\s+(.+)$/i);
      return match ? [match[1], match[2]] : [line.replace(/:$/, "")];
    });
  const issues: string[] = [];
  function block(label: string): string[] {
    const indices = lines.flatMap((line, i) => line.toLowerCase() === label.toLowerCase() ? [i] : []);
    if (indices.length !== 1) { issues.push(`UNIONBANK_${label.toUpperCase().replace(/ /g, "_")}_MISSING_OR_AMBIGUOUS`); return []; }
    const start = indices[0] + 1;
    const end = lines.findIndex((line, i) => i >= start && (LABEL.test(line) || /thank you for using/i.test(line)));
    return lines.slice(start, end < 0 ? lines.length : end);
  }
  const referenceBlock = block("Reference Number");
  const ref = referenceBlock.length === 1 && /^UB\d{6,20}$/i.test(normalize(referenceBlock[0]))
    ? normalize(referenceBlock[0]) : null;
  const typed = normalize(options.typedReference || "");
  const railBlock = block("Instapay Reference Number");
  const rail = railBlock.length === 1 && /^\d{6,20}$/.test(railBlock[0]) ? railBlock[0] : null;
  const status = block("Status");
  const statusTime = status.slice(1).join(" ").replace(/\|/g, " ");
  const timestamp = parseTimestamp([statusTime]);
  if (!/^[A-Za-z]+ \d{1,2},? \d{4}\s+\d{1,2}:\d{2}\s*(AM|PM)$/i.test(statusTime.trim())) {
    timestamp.completeness = "invalid";
    timestamp.instant = null;
  }
  const via = block("Sent Via");
  const to = block("To");
  const amountBlock = block("Amount");
  const amount = extractReceiptAmount(`Amount\n${amountBlock.join("\n")}`, { provider: "unionbank" });
  if (amountBlock.length !== 1 || !/^PHP\s+\d[\d,]*\.\d{2}$/i.test(amountBlock[0] || "")) {
    amount.reliable = false;
    issues.push("AMOUNT_UNREADABLE");
  }
  const allAmounts = extractReceiptAmount(lines.join("\n"), { provider: "unionbank" });
  if (allAmounts.candidates.some(c => !c.excluded && c.amount !== amount.amount)) {
    amount.ambiguous = true;
    amount.reliable = false;
    issues.push("AMOUNT_CONFLICT");
  }
  if (/\b(?:BDO|BPI|Maya|GoTyme|MariBank)\b/i.test(rawText)) issues.push("METHOD_MISMATCH");
  const recipientValid = to.length === 2 && /^GCash$/i.test(to[1]);
  if (!recipientValid) issues.push("UNIONBANK_RECIPIENT_LAYOUT_UNREADABLE");
  if (!ref) issues.push("REF_UNREADABLE");
  if (!rail) issues.push("INSTAPAY_REF_UNREADABLE");
  return {
    provider: "unionbank", destinationProvider: "gcash", parserVersion: "unionbank_to_gcash_v1",
    reference: { value: ref, raw: referenceBlock[0] || null, source: ref ? "reference_label" : "missing",
      label: "Reference Number", lineIndex: lines.findIndex(l => /^Reference Number$/i.test(l)),
      confidence: ref ? "high" : "low", typedMatch: !typed ? "not_provided" : !/^UB\d{6,20}$/.test(typed)
        ? "typed_invalid" : !ref ? "ocr_missing" : typed === ref ? "match" : "mismatch" },
    railReference: { scheme: "instapay", value: rail, raw: railBlock[0] || null,
      confidence: rail ? "high" : "low", lineIndex: lines.findIndex(l => /^Instapay Reference Number$/i.test(l)) },
    amount, timestamp,
    recipient: { nameRaw: recipientValid ? to[0] : null, accountRaw: null, phoneNormalized: null,
      phoneLast4: null, phoneVisibility: "missing", lineIndex: lines.findIndex(l => /^To$/i.test(l)) },
    indicators: {
      providerBrand: /\bThank you for using UnionBank Online\b/i.test(lines.join(" ")),
      competingProviderBrand: null,
      transferSuccess: /^Successful$/i.test(status[0] || "") &&
        !/\b(?:pending|processing|failed|unsuccessful|reversed|cancelled|canceled)\b/i.test(rawText),
      destinationGcash: recipientValid,
      instaPay: via.length === 1 && /^insta\s*(?:Pay|Fay)$/i.test(via[0]),
      officialTransactionReceipt: true,
    }, issues,
  };
}

export function verifyUnionbankToGcashReceipt(
  receipt: BankToGcashReceiptParse & { provider: "unionbank" },
  context: ReceiptVerificationContext,
): BankReceiptVerificationEvidence & { provider: "unionbank" } {
  const flags = [...receipt.issues];
  const expected = normalize(context.expectedRecipientName || "");
  const actual = normalize(receipt.recipient.nameRaw || "");
  const name = !expected ? "not_configured" : !actual ? "missing" : expected === actual ? "exact" : "mismatch";
  if (name !== "exact") flags.push(name === "not_configured" ? "MERCHANT_CONFIG_MISSING" : "RECEIVER_NAME_MISMATCH");
  if (!receipt.indicators.providerBrand) flags.push("UNIONBANK_RECEIPT_UNREADABLE");
  if (receipt.indicators.competingProviderBrand) flags.push("METHOD_MISMATCH");
  if (!receipt.indicators.transferSuccess) flags.push("TRANSFER_STATUS_UNREADABLE");
  if (!receipt.indicators.instaPay) flags.push("INSTAPAY_QRPH_UNREADABLE");
  if (!receipt.indicators.destinationGcash) flags.push("GXI_DESTINATION_UNREADABLE");
  if (receipt.reference.typedMatch !== "match") flags.push("REF_MISMATCH");
  if (!context.pricingAvailable || context.expectedAmount == null) flags.push("PRICING_UNAVAILABLE");
  else if (!receipt.amount.reliable || receipt.amount.ambiguous || receipt.amount.amount == null) flags.push("AMOUNT_UNREADABLE");
  else if (Math.abs(receipt.amount.amount - context.expectedAmount) > context.amountTolerance) flags.push("AMOUNT_MISMATCH");
  const started = Date.parse(context.bookingStartedAt || "");
  const paid = Date.parse(receipt.timestamp.instant || "");
  const age = (paid - started) / 60000;
  if (!Number.isFinite(age) || receipt.timestamp.completeness !== "date_time") flags.push("TIME_UNREADABLE");
  else if (age < -context.earlyToleranceMinutes || age > context.paymentWindowMinutes) flags.push("TIME_EXPIRED");
  if (!receipt.timestamp.date || receipt.timestamp.date !== context.bookingStartedDate) flags.push("DATE_NOT_TODAY");
  // Keep the UB reference as the primary identity. A short InstaPay trace can
  // repeat across dates/providers, so check it independently within this bank
  // and receipt date. A collision queues review through the shared replay guard.
  const dedupeKeys: ReceiptDedupeKey[] = receipt.reference.value ? [{
    key: `unionbank:${receipt.reference.value}`,
    providerKey: "unionbank", duplicateFlag: "DUPLICATE_REF",
  }] : [];
  if (receipt.railReference.value && receipt.timestamp.date &&
      receipt.timestamp.completeness === "date_time") {
    dedupeKeys.push({
      key: `unionbank_instapay:${receipt.timestamp.date}:${receipt.railReference.value}`,
      providerKey: "unionbank_instapay", duplicateFlag: "DUPLICATE_INSTAPAY_REF",
    });
  }
  return {
    provider: "unionbank", destinationProvider: "gcash", parserVersion: "unionbank_to_gcash_v1",
    flags: [...new Set(flags)], recipientComparison: { name, phone: "missing", account: "missing" },
    dedupeKeys,
  };
}

import {
  type BankReceiptVerificationEvidence,
  type BankToGcashReceiptParse,
  parseBankToGcashReceipt,
  type ReceiptVerificationContext,
  verifyBankToGcashReceipt,
} from "./bank-to-gcash.ts";

const GOTYME_CONFIG = {
  provider: "gotyme" as const,
  parserVersion: "gotyme_to_gcash_v1" as const,
  brandPattern: /\bgo\s*tyme\b|\bgotyme\b/i,
  competingBrandPattern: /\bmari\s*bank\b|\bmaribank\b/i,
  competingProvider: "maribank" as const,
  unreadableFlag: "GOTYME_RECEIPT_UNREADABLE",
};

export function parseGotymeToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): BankToGcashReceiptParse & { provider: "gotyme" } {
  // Repair only the bounded GoTyme details block. Customer input never
  // supplies missing OCR evidence.
  let text = rawText;
  const lines = rawText.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line) => /^Trace ID$/i.test(line));
  const date = lines.findIndex((line, index) =>
    index > start &&
    /^\d{1,2} [A-Za-z]+ \d{4} at \d{1,2}:\d{2}(?: [AP]M)?$/i.test(line)
  );
  if (start >= 0 && date > start && date - start <= 12) {
    const block = lines.slice(start, date + 1);
    const refs = block.filter((line) => /^ITO\d{15}$/i.test(line));
    const traces = block.filter((line) => /^\d{6}$/.test(line));
    if (
      refs.length === 1 && traces.length === 1 &&
      refs[0].endsWith(traces[0]) &&
      block.some((line) => /^Reference No\.$/i.test(line))
    ) {
      text = text.replace(/^Reference No\.\s*$/im, `Reference No. ${refs[0]}`)
        .replace(/^Trace ID\s*$/im, `Trace ID ${traces[0]}`);
    }
  }
  text = text.replace(/^instaFay$/im, "instaPay");
  return parseBankToGcashReceipt(text, options, GOTYME_CONFIG) as
    & BankToGcashReceiptParse
    & { provider: "gotyme" };
}

export function verifyGotymeToGcashReceipt(
  parsed: BankToGcashReceiptParse & { provider: "gotyme" },
  context: ReceiptVerificationContext,
): BankReceiptVerificationEvidence & { provider: "gotyme" } {
  return verifyBankToGcashReceipt(
    parsed,
    context,
    GOTYME_CONFIG.unreadableFlag,
  ) as BankReceiptVerificationEvidence & { provider: "gotyme" };
}

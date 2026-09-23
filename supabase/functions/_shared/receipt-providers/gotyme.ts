import {
  type BankReceiptVerificationEvidence,
  type BankToGcashReceiptParse,
  parseBankToGcashReceipt,
  type ReceiptVerificationContext,
  verifyBankToGcashReceipt,
} from "./bank-to-gcash.ts";

const GOTYME_CONFIG = {
  provider: "gotyme" as const,
  parserVersion: "gotyme_to_gcash_v2" as const,
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
  const lines = rawText.split(/\r?\n/).map((line) => line.trim());
  // Some screenshots place the To label above the transfer header in Vision's
  // reading order. Recover only the recipient triple directly before GCash,
  // with known display-only header lines between To and that triple.
  const headerTo = lines.findIndex((line) => /^To$/i.test(line));
  const headerFrom = lines.findIndex((line, index) =>
    index > headerTo && /^From$/i.test(line)
  );
  if (headerTo >= 0 && headerFrom > headerTo && headerFrom - headerTo <= 10) {
    const destination = headerFrom - 1;
    const prefix = lines.slice(headerTo + 1, destination - 2);
    if (
      destination - 2 > headerTo && prefix.length > 0 &&
      /^G-Xchange,?\s*Inc\.?\s*\(GCash\)$/i.test(lines[destination]) &&
      /^[*•●·.xX\s]+[A-Z0-9]{4}$/i.test(lines[destination - 1]) &&
      /^[A-Za-z][A-Za-z .*-]+$/.test(lines[destination - 2]) &&
      prefix.every((line) =>
        /^(?:Transferred[!.]?|Share|Repeat|Add to favorites|[P₱$]\s*[\d,]+\.\d{2})$/i
          .test(line)
      )
    ) {
      lines.splice(
        headerTo,
        headerFrom - headerTo,
        ...prefix,
        "To",
        ...lines.slice(destination - 2, destination + 1),
      );
    }
  }
  // Vision can read the left column (To, From) before the right column.
  // Recover only the complete, bounded recipient/sender layout, never names
  // or account digits from elsewhere on the receipt or from customer input.
  const to = lines.findIndex((line) => /^To$/i.test(line));
  if (
    to >= 0 && /^From$/i.test(lines[to + 1] || "") &&
    /^G-Xchange,?\s*Inc\.?\s*\(GCash\)$/i.test(lines[to + 4] || "") &&
    /^GoTyme Bank$/i.test(lines[to + 7] || "") &&
    /^[*•●·.xX\s]+[A-Z0-9]{4}$/i.test(lines[to + 3] || "") &&
    /^[*•●·.xX\s]+\d{4}$/.test(lines[to + 6] || "")
  ) {
    lines.splice(
      to,
      8,
      "To",
      ...lines.slice(to + 2, to + 5),
      "From",
      ...lines.slice(to + 5, to + 8),
    );
  }
  // OCR may collapse many masking stars into one. Normalize the mask only;
  // the four observed suffix characters still have to match configured QR
  // details AND the recipient name must match independently in the verifier.
  const recipientStart = lines.findIndex((line) => /^To$/i.test(line));
  const recipientEnd = lines.findIndex((line, index) =>
    index > recipientStart && /^From$/i.test(line)
  );
  if (
    recipientStart >= 0 && recipientEnd > recipientStart &&
    recipientEnd - recipientStart <= 5
  ) {
    for (let index = recipientStart + 1; index < recipientEnd; index++) {
      const masked = lines[index].match(/^[*•●·.]+\s*([A-Z0-9]{4})$/i);
      if (masked && /[A-Z]/i.test(masked[1])) lines[index] = "***" + masked[1];
    }
  }
  let text = lines.join("\n");
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

import {
  type BankReceiptVerificationEvidence,
  type BankToGcashReceiptParse,
  parseBankToGcashReceipt,
  type ReceiptVerificationContext,
  verifyBankToGcashReceipt,
} from "./bank-to-gcash.ts";
import { extractReceiptAmount } from "../receipt-amount.ts";

const MARIBANK_CONFIG = {
  provider: "maribank" as const,
  parserVersion: "maribank_to_gcash_v1" as const,
  brandPattern: /\bmari\s*bank\b|\bmaribank\b/i,
  competingBrandPattern: /\bgo\s*tyme\b|\bgotyme\b/i,
  competingProvider: "gotyme" as const,
  unreadableFlag: "MARIBANK_RECEIPT_UNREADABLE",
};

export function parseMaribankToGcashReceipt(
  rawText: string,
  options: { typedReference?: string } = {},
): BankToGcashReceiptParse & { provider: "maribank" } {
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(
    Boolean,
  );
  // Transfer Result is a different screen from the downloadable Transaction
  // Receipt. Recover its observed fields, but never manufacture its missing
  // transaction timestamp from the phone's status-bar clock.
  const destination = lines.findIndex((line) =>
    /^G-Xchange\s*\/\s*GCash$/i.test(line)
  );
  const rail = lines.findIndex((line) => /^insta\s*pay$/i.test(line));
  const required = [
    "From",
    "To",
    "Transfer Amount",
    "Transfer Fee",
    "Total Amount",
    "Reference Number",
    "Transfer Method",
    "Processing Time",
    "Transfer Result",
  ];
  const values = rail >= 4 ? lines.slice(rail - 4, rail) : [];
  const displayedAmounts = lines.filter((line) =>
    /^PHP\s+[\d,]+\.\d{2}$/i.test(line)
  );
  if (
    required.every((label) => lines.includes(label)) &&
    lines.some((line) => /^Transfer Successful!$/i.test(line)) &&
    destination > 0 &&
    /^Acct No\.:\s*[A-Z0-9]{12,40}$/i.test(lines[destination + 1] || "") &&
    values.length === 4 && /^PHP\s+[\d,]+\.\d{2}$/i.test(values[0]) &&
    /^FREE$/i.test(values[1]) && values[0] === values[2] &&
    displayedAmounts.length === 3 &&
    displayedAmounts.every((line) => line === values[0]) &&
    /^\d{6,20}$/.test(values[3]) &&
    lines.filter((line) => /^\d{6,20}$/.test(line)).length === 1
  ) {
    const text = [
      ...lines.filter((line) => line !== "Processing Time"),
      `Reference Number: ${values[3]}`,
    ].join("\n");
    const parsed = parseBankToGcashReceipt(text, options, MARIBANK_CONFIG);
    parsed.amount = extractReceiptAmount(
      `Amount: ${values[0]}\nTotal: ${values[2]}`,
      { provider: "maribank" },
    );
    parsed.recipient = {
      nameRaw: lines[destination - 1],
      accountRaw: lines[destination + 1].replace(/^Acct No\.:\s*/i, ""),
      phoneNormalized: null,
      phoneLast4: null,
      phoneVisibility: "missing",
      lineIndex: destination - 1,
    };
    parsed.issues = parsed.issues.filter((issue) =>
      !["RECIPIENT_PHONE_MISSING", "RECIPIENT_NAME_MISSING"].includes(issue)
    );
    return parsed as BankToGcashReceiptParse & { provider: "maribank" };
  }
  return parseBankToGcashReceipt(rawText, options, MARIBANK_CONFIG) as
    & BankToGcashReceiptParse
    & { provider: "maribank" };
}

export function verifyMaribankToGcashReceipt(
  parsed: BankToGcashReceiptParse & { provider: "maribank" },
  context: ReceiptVerificationContext,
): BankReceiptVerificationEvidence & { provider: "maribank" } {
  return verifyBankToGcashReceipt(
    parsed,
    context,
    MARIBANK_CONFIG.unreadableFlag,
  ) as BankReceiptVerificationEvidence & { provider: "maribank" };
}

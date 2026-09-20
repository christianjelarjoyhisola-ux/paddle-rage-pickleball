import type { GcashReceiptParse } from "./gcash-receipt.ts";
import type { GoogleVisionWord } from "./google-vision.ts";

type OcrFieldMatch = {
  confidence: number;
  numericConfidence: number;
  minDigitConfidence: number;
};

type GcashCriticalOcrQuality = {
  pass: boolean;
  amountTokenizationFallbackEligible: boolean;
  confidence: number | null;
  coverage: number;
  amountOccurrences: number;
  fields: Record<string, number | null>;
};

function normalizeOcrField(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findOcrFieldMatches(
  words: GoogleVisionWord[],
  expected: string | null | undefined,
): OcrFieldMatch[] {
  const target = normalizeOcrField(String(expected || ""));
  if (!target) return [];
  const tokens = words.map((word) => ({
    ...word,
    normalized: normalizeOcrField(word.text),
  })).filter((word) => word.normalized);
  const matches: OcrFieldMatch[] = [];

  for (let start = 0; start < tokens.length; start++) {
    let combined = "";
    const confidences: number[] = [];
    const numericConfidences: number[] = [];
    const digitConfidences: number[] = [];
    for (let cursor = start; cursor < tokens.length; cursor++) {
      combined += tokens[cursor].normalized;
      confidences.push(tokens[cursor].confidence);
      if (/\d/.test(tokens[cursor].text)) {
        numericConfidences.push(tokens[cursor].confidence);
        digitConfidences.push(tokens[cursor].minDigitConfidence);
      }
      if (combined === target) {
        matches.push({
          confidence: confidences.reduce((sum, value) => sum + value, 0) /
            confidences.length,
          numericConfidence: numericConfidences.length
            ? numericConfidences.reduce((sum, value) => sum + value, 0) /
              numericConfidences.length
            : 0,
          minDigitConfidence: digitConfidences.length
            ? Math.min(...digitConfidences)
            : 0,
        });
        break;
      }
      if (combined.length >= target.length || !target.startsWith(combined)) {
        break;
      }
    }
  }
  return matches;
}

export function evaluateGcashCriticalOcrQuality(
  words: GoogleVisionWord[],
  receipt: GcashReceiptParse,
): GcashCriticalOcrQuality {
  const reference = findOcrFieldMatches(words, receipt.reference.value)[0];
  const amountValue = receipt.amount.amount == null
    ? null
    : receipt.amount.amount.toFixed(2);
  const amountMatches = findOcrFieldMatches(words, amountValue);
  const timestamp = findOcrFieldMatches(words, receipt.timestamp.raw)[0];
  const phone = findOcrFieldMatches(words, receipt.receiver.phone.raw)[0] ||
    (receipt.receiver.phone.visibility === "masked"
      ? findOcrFieldMatches(words, receipt.receiver.phone.last4)[0]
      : undefined);
  const labelMatches = [
    findOcrFieldMatches(words, "Sent via GCash")[0],
    findOcrFieldMatches(words, "Total Amount Sent")[0],
    findOcrFieldMatches(words, "Ref No")[0],
  ];
  const requiredFields = [reference, timestamp, phone, ...labelMatches];
  const coveredFields = requiredFields.filter(Boolean).length +
    (amountMatches.length >= 2 ? 1 : 0);
  const coverage = coveredFields / (requiredFields.length + 1);
  const numericMatches = [reference, timestamp, phone, ...amountMatches]
    .filter((match): match is OcrFieldMatch => Boolean(match));
  const requiredNumericFieldsPresent = Boolean(
    reference && timestamp && phone && amountMatches.length >= 1,
  );
  const numericPass = requiredNumericFieldsPresent &&
    numericMatches.every((match) =>
      match.numericConfidence >= 0.92 && match.minDigitConfidence >= 0.8
    );
  const labelsPass = labelMatches.every((match) =>
    Boolean(match && match.confidence >= 0.85)
  );
  const confidence = numericMatches.length
    ? Math.min(...numericMatches.map((match) => match.numericConfidence))
    : null;

  return {
    // At least 6 of 7 fields must be covered. All labels and numeric fields remain mandatory;
    // the parser must independently confirm both displayed amounts agree.
    pass: coverage >= 0.8 && numericPass && labelsPass &&
      receipt.amount.matchingPrimaryAmountDisplays &&
      !receipt.amount.conflictingPrimaryAmounts,
    // Vision can merge a peso symbol with one amount token (for example,
    // `₱2400.00`), making an exact word-token lookup see only one of the two
    // identical amount displays. The parser still proves both displays agree.
    amountTokenizationFallbackEligible: coverage >= 0.8 && amountMatches.length === 1 &&
      numericPass && labelsPass &&
      receipt.amount.matchingPrimaryAmountDisplays &&
      !receipt.amount.conflictingPrimaryAmounts,
    confidence,
    coverage,
    amountOccurrences: amountMatches.length,
    fields: {
      reference: reference?.numericConfidence ?? null,
      amount: amountMatches.length
        ? Math.min(...amountMatches.map((match) => match.numericConfidence))
        : null,
      timestamp: timestamp?.numericConfidence ?? null,
      phone: phone?.numericConfidence ?? null,
      labels: labelMatches.every(Boolean)
        ? Math.min(...labelMatches.map((match) => match!.confidence))
        : null,
    },
  };
}

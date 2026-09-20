import { evaluateGcashCriticalOcrQuality } from "./gcash-ocr-quality.ts";
import { parseGcashReceipt } from "./gcash-receipt.ts";

const text = `J•• KE••••H M.
+63 945 510 7667
Sent via GCash
Amount
3600.00
Total Amount Sent
₱3600.00
Ref No. 7045268478164 Sep 20, 2026 09:38 PM`;
const receipt = parseGcashReceipt(text);
const tokens = [receipt.reference.value!, receipt.timestamp.raw!, receipt.receiver.phone.raw!,
  "3600.00", "3600.00", "Sent via GCash", "Total Amount Sent", "Ref No"];
function quality(values = tokens, confidence = 0.95, digitConfidence = 0.95) {
  return evaluateGcashCriticalOcrQuality(values.map((text) => ({
    text, confidence, minSymbolConfidence: digitConfidence,
    minDigitConfidence: digitConfidence,
  })), receipt);
}
function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
Deno.test("80% coverage permits amount tokenization gaps with every label present", () => {
  assert(quality().pass, "complete receipt");
  for (const index of [3, 4]) {
    const result = quality(tokens.filter((_, i) => i !== index));
    assert(result.coverage === 6 / 7 && result.pass, `missing token ${index}`);
  }
});
Deno.test("86% coverage never permits a missing required label", () => {
  for (const index of [5, 6, 7]) {
    const result = quality(tokens.filter((_, i) => i !== index));
    assert(result.coverage === 6 / 7, "86% coverage");
    assert(!result.pass && !result.amountTokenizationFallbackEligible,
      `required label ${index} must not be waived`);
  }
});
Deno.test("80% coverage never waives numeric identity or confidence", () => {
  for (const index of [0, 1, 2]) {
    assert(!quality(tokens.filter((_, i) => i !== index)).pass, `numeric ${index}`);
  }
  assert(!quality(tokens.filter((_, i) => i < 6)).pass, "two missing labels");
  assert(!quality(tokens, 0.91).pass, "uncertain numeric reading");
  assert(!quality(tokens, 0.95, 0.79).pass, "uncertain digit");
  assert(!quality(tokens.filter((_, i) => i !== 3 && i !== 4)).pass, "no amount");
});
Deno.test("80% coverage still requires parser-confirmed matching amounts", () => {
  const words = tokens.map((text) => ({ text, confidence: 0.95,
    minSymbolConfidence: 0.95, minDigitConfidence: 0.95 }));
  for (const amount of [
    { ...receipt.amount, matchingPrimaryAmountDisplays: false },
    { ...receipt.amount, conflictingPrimaryAmounts: true },
  ]) {
    const result = evaluateGcashCriticalOcrQuality(words, { ...receipt, amount });
    assert(!result.pass && !result.amountTokenizationFallbackEligible, "amount conflict");
  }
});

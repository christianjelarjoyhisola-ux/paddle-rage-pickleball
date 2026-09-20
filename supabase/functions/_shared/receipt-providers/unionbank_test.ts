import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";

const RECEIPT = `Reference Number
UB678039
Status
Successful
Sep 20, 2026 | 09:53 PM
Sent Via
instaPay
Instapay Reference Number
748809
To
PaddleRage
GCash
Amount
PHP 4,800.00
From
Example Sender
Personal Savings
**** **** 9842
Thank you for using UnionBank Online`;
const CONTEXT = {
  typedReference: "UB678039", expectedAmount: 4800, pricingAvailable: true,
  amountTolerance: 0.01, expectedRecipientName: "PaddleRage",
  bookingStartedAt: "2026-09-20T13:50:00Z", bookingStartedDate: "2026-09-20",
  paymentWindowMinutes: 15, earlyToleranceMinutes: 2,
};
function verify(text = RECEIPT, context = {}) {
  const merged = { ...CONTEXT, ...context };
  return verifyProviderReceipt(parseProviderReceipt("unionbank", text, { typedReference: merged.typedReference }), merged);
}
function assert(value: unknown, message: string) { if (!value) throw Error(message); }
Deno.test("UnionBank supplied layout uses dedicated parser and verifier", () => {
  const parsed = parseProviderReceipt("unionbank", RECEIPT, { typedReference: "UB678039" });
  assert(parsed.parserVersion === "unionbank_to_gcash_v1", "dedicated parser");
  assert(parsed.receipt.amount.amount === 4800, "principal amount");
  assert(parsed.receipt.timestamp.instant === "2026-09-20T13:53:00.000Z", "Manila time");
  const result = verify();
  assert(result.flags.length === 0, JSON.stringify(result.flags));
  assert(result.dedupeKeys.length === 2 && result.dedupeKeys[0].key === "unionbank:UB678039", "UB remains the primary replay identity");
  assert(result.dedupeKeys[1].key === "unionbank_instapay:2026-09-20:748809", "independent date-scoped trace");
  assert(result.provider === "unionbank" && result.recipientComparison.account === "missing", "never claim account match");
});
Deno.test("UnionBank duplicate trace is detected even with a different UB reference", () => {
  const original = verify();
  const other = verify(RECEIPT.replace("UB678039", "UB678040"), { typedReference: "UB678040" });
  const claimed = new Set(original.dedupeKeys.map(k => k.key));
  const duplicateFlags = other.dedupeKeys.filter(k => claimed.has(k.key)).map(k => k.duplicateFlag);
  assert(other.flags.length === 0, "otherwise clean evidence");
  assert(duplicateFlags.length === 1 && duplicateFlags[0] === "DUPLICATE_INSTAPAY_REF", "trace duplicate alone queues review");
  const sameUb = verify(RECEIPT.replace("748809", "748810"));
  assert(sameUb.dedupeKeys.filter(k => claimed.has(k.key))[0]?.duplicateFlag === "DUPLICATE_REF", "UB duplicates remain protected");
});
Deno.test("UnionBank trace keys preserve date boundaries and require a readable timestamp", () => {
  const nextDay = verify(RECEIPT.replace("Sep 20", "Sep 21"), {
    bookingStartedAt: "2026-09-21T13:50:00Z", bookingStartedDate: "2026-09-21",
  });
  assert(nextDay.dedupeKeys[1].key === "unionbank_instapay:2026-09-21:748809", "trace date scope");
  for (const text of [RECEIPT.replace("748809", ""), RECEIPT.replace("09:53 PM", "09:53")]) {
    const result = verify(text);
    assert(result.dedupeKeys.every(k => k.providerKey !== "unionbank_instapay"), "no fabricated trace key");
    assert(result.flags.length > 0, "incomplete evidence stays in review");
  }
});
Deno.test("UnionBank supports inline labels and split timestamps", () => {
  for (const text of [RECEIPT.replace("Reference Number\nUB", "Reference Number: UB"),
    RECEIPT.replace("Sep 20, 2026 | 09:53 PM", "Sep 20, 2026\n09:53 PM"),
    RECEIPT.replace("Amount\nPHP", "Amount PHP"), RECEIPT.replace("instaPay", "instaFay")]) {
    assert(verify(text).flags.length === 0, JSON.stringify(verify(text).flags));
  }
});
Deno.test("UnionBank keeps every missing or conflicting field in review", () => {
  for (const [before, after] of [
    ["UB678039", "748809"], ["UB678039", "UB678040"],
    ["Reference Number\nUB678039", "Reference Number\nUB678039\nUB678040"],
    ["Successful", "Pending"], ["Successful", "Unsuccessful"],
    ["09:53 PM", "09:53"], ["Sep 20", "Sep 32"],
    ["instaPay", "PESONet"], ["748809", ""],
    ["PaddleRage", "Another Merchant"], ["GCash", "Other Bank"],
    ["To\nPaddleRage\nGCash", "To\nGCash"],
    ["PHP 4,800.00", "PHP 48.00"], ["Amount\n", ""],
    ["UnionBank Online", "Other Bank"],
    ["From", "Amount\nPHP 1.00\nFrom"],
    ["Personal Savings", "Sent via BPI"],
  ]) assert(verify(RECEIPT.replace(before, after)).flags.length > 0, `must review ${before} -> ${after}`);
});
Deno.test("UnionBank enforces booking context and never synthesizes missing evidence", () => {
  for (const context of [{ typedReference: "748809" }, { typedReference: "" },
    { expectedRecipientName: "" }, { expectedAmount: 100 }, { pricingAvailable: false },
    { bookingStartedAt: "2026-09-20T12:00:00Z" }, { bookingStartedAt: null },
    { bookingStartedDate: "2026-09-21" }]) {
    assert(verify(RECEIPT, context).flags.length > 0, JSON.stringify(context));
  }
});

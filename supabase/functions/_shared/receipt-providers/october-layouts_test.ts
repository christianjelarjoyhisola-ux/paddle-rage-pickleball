import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";
import { compareGcashMaskedName } from "../gcash-receipt.ts";

function eq(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
const context = {
  typedReference: "1234567890123", expectedAmount: 1600, pricingAvailable: true,
  amountTolerance: 0.01, expectedRecipientNumber: "09123457667",
  expectedRecipientName: "Jay Kenneth Miller", bookingStartedAt: "2026-10-03T08:40:00Z",
  bookingStartedDate: "2026-10-03", paymentWindowMinutes: 15, earlyToleranceMinutes: 2,
};
const gcash = `Amount\nJ.. KE...H M.\n+63 912 345 7667\nSent via GCash\nTotal Amount Sent\nRef No. 1234567890123\n(\n1,600.00\nP1600.00\nGCash\nGStocks PH\nMay chance kang kumita as a\nPART\nOct 3, 2026 4:42 PM`;

Deno.test("October GCash columns recover two agreeing amounts before advertising", () => {
  const p = parseProviderReceipt("gcash", gcash, { typedReference: context.typedReference });
  eq(verifyProviderReceipt(p, context).flags, []);
  eq(p.receipt.amount.reliable, true);
  const bad = parseProviderReceipt("gcash", gcash.replace("P1600.00", "P1601.00"), { typedReference: context.typedReference });
  eq(verifyProviderReceipt(bad, context).flags.length > 0, true);
  const adOnly = parseProviderReceipt("gcash", gcash.replace("1,600.00\nP1600.00", "GCash\n1,600.00\nP1600.00"));
  eq(adOnly.receipt.amount.reliable, false);
});
Deno.test("amount after complete reference remains evidence, not an inferred price", () => {
  const p = parseProviderReceipt("gcash", gcash.replace("(\n", ""));
  eq(p.receipt.amount.reliable, true);
  eq(verifyProviderReceipt(p, { ...context, expectedAmount: 1500 }).flags.includes("AMOUNT_MISMATCH"), true);
});
Deno.test("collapsed phone mask requires independently compatible name", () => {
  const raw = gcash.replace("+63 912 345 7667", "+63 9.7667");
  eq(verifyProviderReceipt(parseProviderReceipt("gcash", raw), context).flags, []);
  const unclear = raw.replace("KE...H", "KEH");
  eq(verifyProviderReceipt(parseProviderReceipt("gcash", unclear), context).flags.includes("NUMBER_UNREADABLE"), true);
  eq(verifyProviderReceipt(parseProviderReceipt("gcash", raw.replace("7667", "7668")), context).flags.includes("WRONG_GCASH_NUMBER"), true);
});
Deno.test("joined initial is split without accepting substituted letters", () => {
  eq(compareGcashMaskedName("J..KE...H M.", "Jay Kenneth Miller"), "masked_compatible");
  eq(compareGcashMaskedName("J..XE...H M.", "Jay Kenneth Miller"), "mismatch");
});
Deno.test("BDO full recipient columns and split invoice preserve destination", () => {
  const p = parseProviderReceipt("bdopay", `Sent!\nPHP 700.00\nOct 02, 2026 10:15 PM\nAmount\nPHP 700.00\nService Fee PHP 0.00\nSend Money\nvia\ninstaPay\nTo\nFrom\nExample Shop\nG-XCHANGE, INC. / GCASH\nABCDEFGH12345678\nSA W/ ATM W/O PASBK-INDIVIDUAL\n........ 9657\nInvoice\n504735\nnumber\nReference no.\nBN-20261002-08501443\nBDO pay`);
  if (p.provider !== "bdopay") throw Error("provider");
  eq(p.receipt.recipient.nameRaw, "Example Shop");
  eq(p.receipt.recipient.accountNormalized, "ABCDEFGH12345678");
  eq(p.receipt.invoice.value, "504735");
});
Deno.test("GoTyme badge and mask-only line cannot become recipient", () => {
  const p = parseProviderReceipt("gotyme", `instaPay\nTo\nTransferred\nP3,600.00\nShare\nI 5G 694\n✓\nExample Shop\n***\n***ONS8\nInstant\nG-Xchange, Inc (GCash)\nFrom\nSENDER NAME\n****4792\nGoTyme Bank\nAmount\nP3,600.00\nFee\nP0.00\nTotal\nP3,600.00\nTrace ID\n553024\nReference No.\nDate\nITO261002050553024\n02 Oct 2026 at 1:05 PM`);
  if (p.provider !== "gotyme") throw Error("provider");
  eq(p.receipt.recipient.nameRaw, "Example Shop");
  eq(p.receipt.recipient.accountRaw, "***ONS8");
});

Deno.test("MariBank transfer result reads anchored 24-hour time but still requires rail evidence", () => {
  const raw = `From\nTo\nTransfer Result\nTransfer Successful!\nPHP 3,200.00\nTransfer Amount\nTransfer Fee\nTotal Amount\nReference Number\nTransfer Method\nProcessing Time\nTransaction Date & Time\nSENDER NAME\nMariBank: 15200000000\nExample Shop\nG-Xchange / GCash\nAcct No.: ABCDEFGH12345678\nPHP 3,200.00\nFREE\nPHP 3,200.00\n250629\ninstaFay\nRealtime\n02 Oct 2026, 16:34`;
  const p = parseProviderReceipt("maribank", raw, { typedReference: "250629" });
  eq(p.receipt.timestamp.instant, "2026-10-02T08:34:00.000Z");
  eq(p.receipt.amount.reliable, true);
  const v = verifyProviderReceipt(p, { ...context, typedReference: "250629", expectedAmount: 3200,
    expectedRecipientName: "Example Shop", expectedRecipientAccount: "ABCDEFGH12345678",
    bookingStartedAt: "2026-10-02T08:33:00Z", bookingStartedDate: "2026-10-02" });
  eq(v.flags, ["INSTAPAY_REF_UNREADABLE"]);
  eq(parseProviderReceipt("maribank", raw.replace("02 Oct 2026, 16:34", "")).receipt.timestamp.instant, null);
});

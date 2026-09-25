import { parseBpiToGcashReceipt, verifyBpiToGcashReceipt } from "./bpi.ts";
const raw =
  "12:01\nl\n73\nTransfer successful!\nFriday, Sep 25 2026; 12:01:23 PM (GMT +8)\nConfirmation No. 1626800000001\nTransaction Ref. No. 123456\nSent via BPI\nTransfer to\nGCash/G-Xchange\nPaddleRage (QR Code)\nXXXXXXXXXXXXXXNS8\nTransfer amount\nPHP 3,600.00\nFee\nPHP 0.00\n^ Hide other details\nTransfer from\nSAVINGS ACCOUNT\nXXXXXX0000 O\nNew transfer\nGo to Accounts\n✓";
const context = {
  typedReference: "1626800000001",
  expectedAmount: 3600,
  pricingAvailable: true,
  amountTolerance: .01,
  expectedRecipientName: "PaddleRage",
  expectedRecipientNumber: "09455107667",
  expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
  bookingStartedAt: "2026-09-25T03:59:44.881Z",
  bookingStartedDate: "2026-09-25",
  paymentWindowMinutes: 15,
  earlyToleranceMinutes: 2,
};
const verify = (text: string, patch = {}) =>
  verifyBpiToGcashReceipt(
    parseBpiToGcashReceipt(text, { typedReference: context.typedReference }),
    { ...context, ...patch },
  );
Deno.test("BPI matching QR receipt accepts off-screen InstaPay label without inventing observed evidence", () => {
  const p = parseBpiToGcashReceipt(raw, {
    typedReference: context.typedReference,
  });
  if (p.indicators.instaPay) throw Error("Invented rail evidence");
  const v = verify(raw);
  if (v.flags.length) throw Error(JSON.stringify(v.flags));
  if (v.dedupeKeys.length !== 2) throw Error("Reference replay guards lost");
});
Deno.test("BPI cropped QR route retains all identity, payment and time checks", () => {
  for (
    const text of [
      raw.replace("PaddleRage (QR Code)", "Wrong Merchant (QR Code)"),
      raw.replace("XXXXXXXXXXXXXXNS8", "XXXXXXXXXXXXXXBAD"),
      raw.replace("XXXXXXXXXXXXXXNS8", "XXXXXXXXXXXXXX"),
      raw.replace("PaddleRage (QR Code)", "PaddleRage") + "\n(QR Code)",
      raw.replace("GCash/G-Xchange", "Other Bank"),
      raw.replace("Transfer successful!", "Transfer processing"),
      raw.replace("Sent via BPI", "Sent via Maya"),
      raw.replace("PHP 3,600.00", "PHP 3,500.00"),
      raw.replace("1626800000001", "1626800000002"),
      raw.replace("Transaction Ref. No. 123456", ""),
      raw.replace("12:01:23 PM", "12:30:23 PM"),
      raw.replace("Friday, Sep 25 2026; 12:01:23 PM (GMT +8)", ""),
      raw + "\nTransfer service\nPESONet",
      raw + "\nSWIFT",
    ]
  ) if (!verify(text).flags.length) throw Error("Unsafe acceptance: " + text);
  if (!verify(raw, { expectedRecipientAccount: "" }).flags.length) {
    throw Error("Missing account configuration accepted");
  }
});

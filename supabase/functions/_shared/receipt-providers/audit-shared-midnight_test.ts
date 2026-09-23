import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";
const fixtures = [
  {
    provider: "gcash",
    reference: "1234567890123",
    raw:
      "Express Send\nPaddle Rage\n09455107667\nSent via GCash\nAmount\n800.00\nTotal Amount Sent\nP800.00\nRef No. 1234567890123\nSep 23, 2026 12:01 AM",
  },
  {
    provider: "gotyme",
    reference: "ITO260922160112345",
    raw:
      "Transferred\nPHP 800.00\ninstaPay\nTo\nPaddle Rage\n*******7667\nG-Xchange, Inc (GCash)\nFrom\nTest Sender\n*******0000\nGoTyme Bank\nAmount\nPHP 800.00\nFee\nPHP 0.00\nTotal\nPHP 800.00\nTrace ID\n123456\nReference No.\nITO260922160112345\nDate\n23 Sep 2026 at 12:01 AM",
  },
  {
    provider: "maribank",
    reference: "MB2026092300000001",
    raw:
      "MariBank\nMoney sent\nRecipient\nPaddle Rage\nGCash\nAccount number 09455107667\nAmount PHP 800.00\nReference No MB2026092300000001\nInstaPay Reference No 987654321234\n2026-09-23 12:01 AM\nvia InstaPay",
  },
];
for (const f of fixtures) {
  Deno.test(`${f.provider} exact window accepts midnight crossing and rejects stale/missing times`, () => {
    const context = {
      typedReference: f.reference,
      expectedAmount: 800,
      pricingAvailable: true,
      amountTolerance: .01,
      expectedRecipientName: "Paddle Rage",
      expectedRecipientNumber: "09455107667",
      bookingStartedAt: "2026-09-22T15:58:00Z",
      bookingStartedDate: "2026-09-22",
      paymentWindowMinutes: 15,
      earlyToleranceMinutes: 2,
    };
    const parsed = parseProviderReceipt(f.provider, f.raw, {
      typedReference: f.reference,
    });
    const evidence = verifyProviderReceipt(parsed, context);
    if (evidence.flags.length) throw Error(JSON.stringify(evidence.flags));
    for (const started of ["2026-09-22T15:40:00Z", "2026-09-21T15:58:00Z"]) {
      const v = verifyProviderReceipt(parsed, {
        ...context,
        bookingStartedAt: started,
      });
      if (!v.flags.includes("TIME_EXPIRED")) {
        throw Error("Stale receipt accepted");
      }
    }
    const missing = structuredClone(parsed);
    missing.receipt.timestamp.instant = null;
    const v = verifyProviderReceipt(missing, context);
    if (!v.flags.includes("TIME_UNREADABLE")) {
      throw Error("Missing timestamp accepted");
    }
  });
}

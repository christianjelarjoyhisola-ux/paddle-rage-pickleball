import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";

const gcash = `12:11 1
Amount
Express Send
J.. KE...H M.
+63 945 510 7667
Sent via GCash
Total Amount Sent
Ref No. 9045249247097
ploom
aura
5G 88
350.00
P350.00
Sep 20, 2026 12:10 PM
Shop Now
P1,490 ONLY`;
const gotyme = `9:32
Transferred
P1,750.00
Share
instaFay
To
PaddleRage
*************ONS8
G-Xchange, Inc (GCash)
From
SENDER
********3301
GoTyme Bank
Amount
$1,750.00
Fee
$9.00
Total
Trace ID
Reference No.
Date
C
P1,759.00
147002
ITO260919133147002
✓
Instant
19 Sep 2026 at 9:31 PM`;
function check(provider: "gcash" | "gotyme", text: string) {
  const typedReference = provider === "gcash"
    ? "9045249247097"
    : "ITO260919133147002";
  const parsed = parseProviderReceipt(provider, text, { typedReference });
  return {
    parsed,
    evidence: verifyProviderReceipt(parsed, {
      typedReference,
      expectedAmount: provider === "gcash" ? 350 : 1750,
      pricingAvailable: true,
      amountTolerance: 0.01,
      expectedRecipientNumber: "09455107667",
      expectedRecipientName: "Jan Kennith Magallano",
      expectedRecipientNameAliases: ["PaddleRage"],
      expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
      bookingStartedAt: provider === "gcash"
        ? "2026-09-20T04:08:00Z"
        : "2026-09-19T13:29:00Z",
      bookingStartedDate: provider === "gcash" ? "2026-09-20" : "2026-09-19",
      paymentWindowMinutes: 15,
      earlyToleranceMinutes: 2,
    }),
  };
}
Deno.test("reported GCash amounts after reference exclude advertisement", () => {
  const result = check("gcash", gcash);
  if (
    result.evidence.flags.length || result.parsed.receipt.amount.amount !== 350
  ) {
    throw new Error(JSON.stringify(result));
  }
});
Deno.test("reported GoTyme QR transfer excludes fee and repairs separated references", () => {
  const result = check("gotyme", gotyme);
  if (
    result.evidence.flags.length || result.parsed.receipt.amount.amount !== 1750
  ) {
    throw new Error(JSON.stringify(result));
  }
});
Deno.test("reordered receipts keep conflicts and incomplete evidence in review", () => {
  for (
    const [provider, text] of [
      ["gcash", gcash.replace("P350.00", "P450.00")],
      ["gcash", gcash.replace("350.00\n", "")],
      ["gotyme", gotyme.replace("ONS8", "BAD8")],
      ["gotyme", gotyme.replace("PaddleRage", "Another Merchant")],
      ["gotyme", gotyme.replace("147002\nITO", "147003\nITO")],
      ["gotyme", gotyme.replace("Transferred", "Pending")],
      ["gotyme", gotyme.replace("ITO260919133147002", "")],
    ] as const
  ) {
    if (!check(provider, text).evidence.flags.length) {
      throw new Error(`Unsafe approval: ${text}`);
    }
  }
});

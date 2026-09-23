import {
  parseGotymeToGcashReceipt,
  verifyGotymeToGcashReceipt,
} from "./gotyme.ts";
const fixtures = [
  {
    "text":
      "Transferred\nP3,100.00\nRepeat\nAdd to favorites\nShare\ninstaPay\nTo\nFrom\nJ. M.\n.......7667\nG-Xchange, Inc (GCash)\nA. CUSTOMER\n........5812\nGoTyme Bank\nAmount\n$3,100.00\nFee\nP0.00\nTotal\nTrace ID\nReference No.\nDate\nP3,100.00\n000004\nITO260923133128004\n23 Sep 2026 at 9:31 PM\nInstant\n✓",
    "context": {
      "typedReference": "ITO260923133128004",
      "expectedAmount": 3100,
      "expectedRecipientNumber": "09455107667",
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientAccount": "DWQM4TK3JDO9O0NS8",
      "expectedRecipientNameAliases": [
        "PaddleRage",
        "Paddle Rage",
      ],
      "bookingStartedAt": "2026-09-23T13:26:10.824Z",
      "bookingStartedDate": "2026-09-23",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2,
      "amountTolerance": 0.01,
      "pricingAvailable": true,
    },
  },
  {
    "text":
      "12:24 1\nTransferred\nP3,600.00\nShare\ninstaFay\nTo\nPaddleRage\n*ONS8\nG-Xchange, Inc (GCash)\nFrom\nL. CUSTOMER\n** 6243\nGoTyme Bank\nAmount\n$3,600.00\nFee\n$9.00\nTotal\nTrace ID\nReference No.\nDate\nGet help\nP3,609.00\n427011\nITO260922162427011\n23 Sep 2026 at 12:24 AM\n✓\nInstant",
    "context": {
      "typedReference": "ITO260922162427011",
      "expectedAmount": 3600,
      "expectedRecipientNumber": "09455107667",
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientAccount": "DWQM4TK3JDO9O0NS8",
      "expectedRecipientNameAliases": [
        "PaddleRage",
        "Paddle Rage",
      ],
      "bookingStartedAt": "2026-09-22T16:22:35.669Z",
      "bookingStartedDate": "2026-09-23",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2,
      "amountTolerance": 0.01,
      "pricingAvailable": true,
    },
  },
];
Deno.test("GoTyme real column-ordered and compressed-mask OCR passes dedicated verification", () => {
  for (const f of fixtures) {
    const p = parseGotymeToGcashReceipt(f.text, {
      typedReference: f.context.typedReference,
    });
    const v = verifyGotymeToGcashReceipt(p, f.context);
    if (v.flags.length) throw Error(JSON.stringify({ p, v }));
    if (p.reference.value !== f.context.typedReference) {
      throw Error("Wrong reference");
    }
  }
});
Deno.test("GoTyme repairs do not accept wrong amount, account, name, time or customer reference", () => {
  for (const f of fixtures) {
    for (
      const patch of [
        { expectedAmount: 1 },
        {
          expectedRecipientNumber: "09123459999",
          expectedRecipientAccount: "OTHERACCOUNT9999",
        },
        {
          expectedRecipientName: "Other Recipient",
          expectedRecipientNameAliases: [],
        },
        { typedReference: "ITO260923133128999" },
        { bookingStartedAt: "2026-09-01T00:00:00Z" },
      ]
    ) {
      const context = { ...f.context, ...patch };
      const p = parseGotymeToGcashReceipt(f.text, {
        typedReference: context.typedReference,
      });
      const v = verifyGotymeToGcashReceipt(p, context);
      if (!v.flags.length) {
        throw Error("Unsafe acceptance " + JSON.stringify(patch));
      }
    }
  }
});

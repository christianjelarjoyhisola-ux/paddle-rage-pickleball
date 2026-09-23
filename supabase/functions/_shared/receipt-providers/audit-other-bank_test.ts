import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";

const fixture89 = {
  "raw":
    "instaFay\nTo\nTransferred\nP1,200.00\nShare\nPaddleRage\n***ONS8\nG-Xchange, Inc (GCash)\nFrom\nC. CUSTOMER\n****\n**4927\nGoTyme Bank\nAmount\n$1,200.00\nFee\nP9.00\nPaid with points\n-P9.00\n9.00 Go Rewards points\nTotal\nTrace ID\nReference No.\nDate\nGet help\n$1,200.00\n906010\nITO260922004906010\n22 Sep 2026 at 8:49 AM\nInstant\n>",
  "provider": "gotyme",
  "context": {
    "typedReference": "ITO260922004906010",
    "expectedAmount": 1200,
    "pricingAvailable": true,
    "amountTolerance": 0.01,
    "expectedRecipientNumber": "09455107667",
    "expectedRecipientName": "Jan Kennith Magallano",
    "expectedRecipientNameAliases": [
      "PaddleRage",
    ],
    "expectedRecipientAccount": "DWQM4TK3JDO9O0NS8",
    "bookingStartedAt": "2026-09-22T00:46:41.050Z",
    "bookingStartedDate": "2026-09-22",
    "paymentWindowMinutes": 15,
    "earlyToleranceMinutes": 2,
  },
};

const fixture102 = {
  "raw":
    "10:15\nFrom\nTo\nTransfer Amount\nTransfer Fee\nTotal Amount\nTransfer Result\nTransfer Successful!\nPHP 800.00\nReference Number\nTransfer Method\nProcessing Time\n43\nN. CUSTOMER\nMariBank: 10012345678\nPaddlerage\nG-Xchange / GCash\nAcct No.: DWQM4TK3JDO900NS8\nShare\nDone\nPHP 800.00\nFREE\nPHP 800.00\n491975\ninstaPay\nRealtime",
  "provider": "maribank",
  "context": {
    "typedReference": "491975",
    "expectedAmount": 800,
    "pricingAvailable": true,
    "amountTolerance": 0.01,
    "expectedRecipientNumber": "09455107667",
    "expectedRecipientName": "Jan Kennith Magallano",
    "expectedRecipientNameAliases": [
      "PaddleRage",
    ],
    "expectedRecipientAccount": "DWQM4TK3JDO9O0NS8",
    "bookingStartedAt": "2026-09-23T02:13:40.046Z",
    "bookingStartedDate": "2026-09-23",
    "paymentWindowMinutes": 15,
    "earlyToleranceMinutes": 2,
  },
};

Deno.test("GoTyme header-displaced recipient verifies from bounded observed evidence", () => {
  const f = fixture89;
  const p = parseProviderReceipt(f.provider, f.raw, {
    typedReference: f.context.typedReference,
  });
  const v = verifyProviderReceipt(p, f.context);
  if (v.flags.length) throw Error(JSON.stringify({ p, v }));
  for (
    const raw of [
      f.raw.replace("***ONS8", "***9999"),
      f.raw.replace("PaddleRage", "Wrong Recipient"),
      f.raw.replace("PaddleRage", "Pending\nPaddleRage"),
    ]
  ) {
    const v = verifyProviderReceipt(
      parseProviderReceipt(f.provider, raw, {
        typedReference: f.context.typedReference,
      }),
      f.context,
    );
    if (!v.flags.length) throw Error("Unsafe recipient/status acceptance");
  }
});
Deno.test("MariBank Transfer Result recovers fields but never uses status-bar time as payment time", () => {
  const f = fixture102;
  const p = parseProviderReceipt(f.provider, f.raw, {
    typedReference: f.context.typedReference,
  });
  const v = verifyProviderReceipt(p, f.context);
  if (
    p.provider !== "maribank" || p.receipt.reference.value !== "491975" ||
    p.receipt.amount.amount !== 800 || !p.receipt.amount.reliable ||
    p.receipt.recipient.nameRaw !== "Paddlerage"
  ) throw Error(JSON.stringify({ p, v }));
  if (
    !v.flags.includes("DATE_UNREADABLE") ||
    !v.flags.includes("TIME_UNREADABLE") || p.receipt.timestamp.instant
  ) throw Error("Invented missing timestamp");
  for (
    const raw of [
      f.raw.replace(
        "PHP 800.00\nFREE\nPHP 800.00",
        "PHP 800.00\nFREE\nPHP 900.00",
      ),
      f.raw.replace("Paddlerage", "Wrong Recipient"),
      f.raw.replace("DWQM4TK3JDO900NS8", "WRONGACCOUNT123456"),
    ]
  ) {
    const v = verifyProviderReceipt(
      parseProviderReceipt(f.provider, raw, {
        typedReference: f.context.typedReference,
      }),
      f.context,
    );
    if (
      !v.flags.some((x) =>
        !["DATE_UNREADABLE", "TIME_UNREADABLE", "INSTAPAY_REF_UNREADABLE"]
          .includes(x)
      )
    ) throw Error("Unsafe conflicting evidence acceptance");
  }
});

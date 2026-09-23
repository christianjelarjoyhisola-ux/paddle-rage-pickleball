// Anonymized layouts from the September 22 receipt audit. Business destination
// stays configured; transaction references and sender suffixes are synthetic.
import {
  configuredBpiMobileAliases,
  parseBpiToGcashReceipt,
  verifyBpiToGcashReceipt,
} from "./bpi.ts";
const fixtures = [
  {
    "id": "87",
    "raw":
      "05:24\n86\n↓ →\nTransfer successful!\nTuesday, Sep 22 2026; 05:23:56 AM (GMT +8)\nConfirmation No. 1626505000001\nTransaction Ref. No. 360001\nSent via BPI\nTransfer to\nGCash/G-Xchange\nJKM\n09455107667\nAdd to Favorites\nTransfer amount\nPHP 350.00\nFee\nPHP 0.00\nNew transfer\nGo to Accounts",
    "context": {
      "typedReference": "1626505000001",
      "expectedAmount": 350,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "PaddleRage",
      "expectedRecipientNumber": "09455107667",
      "expectedRecipientAccount": "DWQM4TK3JDO9O0NS8",
      "expectedRecipientNameAliases": [
        "JKEM",
        "Paddle Rage",
        "Jan Kennith Magallano",
      ],
      "bookingStartedAt": "2026-09-21T21:22:34.621Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2,
    },
    "flags": [
      "RECEIVER_NAME_MISMATCH",
    ],
  },
  {
    "id": "88",
    "raw":
      "Transfer successful!\nTuesday, Sep 22 2026; 05:31:03 AM (GMT +8)\nConfirmation No. 1626505000002\nTransaction Ref. No. 360002\nSent via BPI\nTransfer to\nGCash/G-Xchange\nJKEM\n09455107667\n✰ Add to Favorites\nTransfer amount\nPHP 1,200.00\nFee\nPHP 0.00\n▲ Hide other details\nTransfer from\nSAVINGS ACCOUNT\nXXXXXX0000 O\nTransfer service\nInstaPay\nTransfer using\nAccount number",
    "context": {
      "typedReference": "1626505000002",
      "expectedAmount": 1200,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "PaddleRage",
      "expectedRecipientNumber": "09455107667",
      "expectedRecipientAccount": "DWQM4TK3JDO9O0NS8",
      "expectedRecipientNameAliases": [
        "JKEM",
        "Paddle Rage",
        "Jan Kennith Magallano",
      ],
      "bookingStartedAt": "2026-09-21T21:27:41.464Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2,
    },
    "flags": [],
  },
  {
    "id": "92",
    "raw":
      "Transfer successful!\nTuesday, Sep 22 2026; 11:59:30 AM (GMT +8)\nConfirmation No. 1626505000003\nTransaction Ref. No. 360003\nSent via BPI\nTransfer to\nGCash/G-Xchange\nPaddleRage (QR Code)\nXXXXXXXXXXXXXXNS8\nTransfer amount\nPHP 7,200.00\nFee\nPHP 0.00\nA Hide other details\nTransfer from\nSAVINGS ACCOUNT\nXXXXXX0000 O\nTransfer service\nInstaPay\nTransfer using\nAccount number",
    "context": {
      "typedReference": "1626505000003",
      "expectedAmount": 7350,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "PaddleRage",
      "expectedRecipientNumber": "09455107667",
      "expectedRecipientAccount": "DWQM4TK3JDO9O0NS8",
      "expectedRecipientNameAliases": [
        "JKEM",
        "Paddle Rage",
        "Jan Kennith Magallano",
      ],
      "bookingStartedAt": "2026-09-22T03:57:05.818Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2,
    },
    "flags": [
      "AMOUNT_MISMATCH",
    ],
  },
  {
    "id": "93",
    "raw":
      "Transfer successful!\nTuesday, Sep 22 2026; 01:04:07 PM (GMT +8)\nConfirmation No. 1626505000004\nTransaction Ref. No. 360004\nSent via BPI\nTransfer to\nGCash/G-Xchange\nJan Kennith Magallano\n09455107667\n✰ Add to Favorites\nTransfer amount\nPHP 322.50\nFee\nPHP 0.00\n^ Hide other details\nTransfer from\nSAVINGS ACCOUNT\nXXXXXX0000 O\nTransfer service\nInstaPay\nTransfer using\nAccount number",
    "context": {
      "typedReference": "1626505000004",
      "expectedAmount": 322.5,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "PaddleRage",
      "expectedRecipientNumber": "09455107667",
      "expectedRecipientAccount": "DWQM4TK3JDO9O0NS8",
      "expectedRecipientNameAliases": [
        "JKEM",
        "Paddle Rage",
        "Jan Kennith Magallano",
      ],
      "bookingStartedAt": "2026-09-22T05:01:31.604Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2,
    },
    "flags": [],
  },
  {
    "id": "98",
    "raw":
      "18:10\nIll 5G\n↓ →\nTransfer successful!\nTuesday, Sep 22 2026; 06:09:53 PM (GMT +8)\nConfirmation No. 1626505000470\nTransaction Ref. No. 360005\nSent via BPI\nTransfer to\nGCash/G-Xchange\npaddle rage\n09455107667\nAdd to Favorites\nTransfer amount\nPHP 800.00\nFee\nPHP 0.00\n^ Hide other details\nTransfer from\nSAVINGS ACCOUNT\nXXXXXX0000 O\nNew transfer\nGo to Accounts",
    "context": {
      "typedReference": "1626505000",
      "expectedAmount": 800,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "PaddleRage",
      "expectedRecipientNumber": "09455107667",
      "expectedRecipientAccount": "DWQM4TK3JDO9O0NS8",
      "expectedRecipientNameAliases": [
        "JKEM",
        "Paddle Rage",
        "Jan Kennith Magallano",
      ],
      "bookingStartedAt": "2026-09-22T10:07:38.068Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2,
    },
    "flags": [
      "REF_MISMATCH",
    ],
  },
];
for (const fixture of fixtures) {
  Deno.test("BPI saved Sept22 layout " + fixture.id, () => {
    const result = verifyBpiToGcashReceipt(
      parseBpiToGcashReceipt(fixture.raw, {
        typedReference: fixture.context.typedReference,
      }),
      fixture.context,
    );
    if (JSON.stringify(result.flags) !== JSON.stringify(fixture.flags)) {
      throw Error(JSON.stringify(result.flags));
    }
  });
}

Deno.test("BPI configured legal identity is bound to the exact full mobile destination", () => {
  const config = '{"09455107667":["JKEM","Paddle Rage"]}';
  const legal = { number: "+63 945 510 7667", name: "Jan Kennith Magallano" };
  const aliases = configuredBpiMobileAliases(config, "09455107667", legal);
  if (!aliases.includes(legal.name)) {
    throw Error("Same full-number legal identity missing");
  }
  if (aliases.includes("JKM")) throw Error("Unapproved alias inferred");
  for (const number of ["09455107668", "7667", "DWQM4TK3JDO9O0NS8", ""]) {
    if (
      configuredBpiMobileAliases(config, number, legal).includes(legal.name)
    ) throw Error("Legal name escaped number binding");
  }
  if (
    configuredBpiMobileAliases(config, "09455107667", {
      ...legal,
      number: "09455107668",
    }).includes(legal.name)
  ) throw Error("Different legal number accepted");
  if (configuredBpiMobileAliases(config, "09455107667").includes(legal.name)) {
    throw Error("Legacy config behavior changed");
  }
  const fixture = fixtures.find((item) => item.id === "93")!;
  const context = { ...fixture.context, expectedRecipientNameAliases: aliases };
  const verify = (raw: string) =>
    verifyBpiToGcashReceipt(
      parseBpiToGcashReceipt(raw, { typedReference: context.typedReference }),
      context,
    );
  if (verify(fixture.raw).flags.length) {
    throw Error("Legal mobile payment rejected");
  }
  if (
    !verify(fixture.raw.replace("09455107667", "09455107668")).flags.includes(
      "RECEIVER_ACCOUNT_MISMATCH",
    )
  ) throw Error("Wrong destination accepted");
  const qr = fixture.raw.replace("09455107667", "XXXXXXXXXXXX0NS8").replace(
    legal.name,
    legal.name + " (QR Code)",
  );
  if (!verify(qr).flags.includes("RECEIVER_NAME_MISMATCH")) {
    throw Error("Mobile legal alias authorized QR destination");
  }
});

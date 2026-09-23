import { parseProviderReceipt, verifyProviderReceipt } from "./index.ts";

// Anonymized layouts captured during the September 22–23 receipt audit.
const fixtures = [
  {
    "provider": "gcash",
    "raw": "9:33 1\n100\nYour one-time pin.Express Send\nG\nPlease use 123456 as your OTP for your transaction.\nnow\nAmount\nJ.. KE....H M.\n+63 9.. ... 7667\nSent via GCash\nTotal Amount Sent\n7,200.00\nP7200.00\nRef No. 1000000000000\nSep 22, 2026 9:33 AM\n2799 (gCO2e)\nBy going digital, you reduce your carbon footprint from\ntransportation, paper, and plastic.\n(⇓) Download\nShare Receipt",
    "context": {
      "typedReference": "1000000000000",
      "expectedAmount": 7200,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientNumber": "09455107667",
      "bookingStartedAt": "2026-09-22T01:31:12.171Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2
    }
  },
  {
    "provider": "gcash",
    "raw": "Amount\nJ.. KE...H M.\n+63 945 510 7667\nSent via GCash\n800.00\nTotal Amount Sent\nP800.00\nRef No. 1000000000001\nSep 22, 2026 11:47 AM\n2799 (gCO2e)\nBy going digital, you reduce your carbon footprint\nfrom transportation, paper, and plastic.",
    "context": {
      "typedReference": "1000000000001",
      "expectedAmount": 800,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientNumber": "09455107667",
      "bookingStartedAt": "2026-09-22T03:43:25.436Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2
    }
  },
  {
    "provider": "gcash",
    "raw": "Amount\nJ.. KE....H M.\n+63 9..... 7667\nSent via GCash\n1,200.00\nTotal Amount Sent\nP1200.00\nRef No. 1000000000002\nSep 22, 2026 1:04 PM\n279g (gCO2e)\nBy going digital, you reduce your carbon footprint from\ntransportation, paper, and plastic.",
    "context": {
      "typedReference": "1000000000002",
      "expectedAmount": 1200,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientNumber": "09455107667",
      "bookingStartedAt": "2026-09-22T05:01:40.030Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2
    }
  },
  {
    "provider": "gcash",
    "raw": "Amount\nJ.. KE....H M.\n+63 9..... 7667\nSent via GCash\nTotal Amount Sent\n800.00\nP800.00\nRef No. 1000000000003\nSep 22, 2026 1:12 PM\n279g (gCO2e)\nBy going digital, you reduce your carbon footprint from\ntransportation, paper, and plastic.",
    "context": {
      "typedReference": "1000000000003",
      "expectedAmount": 800,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientNumber": "09455107667",
      "bookingStartedAt": "2026-09-22T05:10:35.981Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2
    }
  },
  {
    "provider": "gcash",
    "raw": "Amount\nJ.. KE....H M.\n+63 9..... 7667\nSent via GCash\n1,200.00\nTotal Amount Sent\nP1200.00\nRef No. 1000000000004\nSep 22, 2026 1:23 PM\n279g (gCO2e)\nBy going digital, you reduce your carbon footprint from\ntransportation, paper, and plastic.",
    "context": {
      "typedReference": "1000000000004",
      "expectedAmount": 1200,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientNumber": "09455107667",
      "bookingStartedAt": "2026-09-22T05:19:58.674Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2
    }
  },
  {
    "provider": "gcash",
    "raw": "Amount\nJ.. KE....H M.\n+63 9..... 7667\nSent via GCash\nTotal Amount Sent\n800.00\nP800.00\nRef No. 1000000000005\nSep 22, 2026 1:28 PM\n279g (gCO2e)\nBy going digital, you reduce your carbon footprint from\ntransportation, paper, and plastic.",
    "context": {
      "typedReference": "1000000000005",
      "expectedAmount": 800,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientNumber": "09455107667",
      "bookingStartedAt": "2026-09-22T05:27:12.351Z",
      "bookingStartedDate": "2026-09-22",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2
    }
  },
  {
    "provider": "unionbank",
    "raw": "Reference Number:\nUB123456\nStatus\nSuccessful\nSep 23, 2026 | 06:36 AM\nFunds have been credited to the recipient.\nRequest Submitted\nSep 23, 2026 | 06:36 AM\nTransfer Details\nSent Via\ninstaFay\nInstapay Reference Number\n654321\nTo\nPaddleRage\nGCash\nAmount\nPHP 1,100.00\nFrom\nEXAMPLE SENDER\nPlayEveryday Debit\n**** **** 0000\nThank you for using UnionBank Online",
    "context": {
      "typedReference": "UB123456",
      "expectedAmount": 1100,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "PaddleRage",
      "expectedRecipientNumber": "",
      "bookingStartedAt": "2026-09-22T22:34:33.193Z",
      "bookingStartedDate": "2026-09-23",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2
    }
  },
  {
    "provider": "gcash",
    "raw": "10:00 RS.\n☑\nExpress Send\nAmount\nJ.. KE....H M.\n+63 945 510 7667\nSent via GCash\nTotal Amount Sent\n5G\n60\n800.00\nP800.00\nRef No. 1000000000007\nSep 23, 2026 10:00 AM\n279g (gCO2e)\nBy going digital, you reduce your carbon footprint from\ntransportation, paper, and plastic.",
    "context": {
      "typedReference": "1000000000007",
      "expectedAmount": 800,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientNumber": "09455107667",
      "bookingStartedAt": "2026-09-23T01:57:59.489Z",
      "bookingStartedDate": "2026-09-23",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2
    }
  },
  {
    "provider": "gcash",
    "raw": "Amount\nJ.. KE....H M.\n+63 945 510 7667\nSent via GCash\nTotal Amount Sent\n800.00\nP800.00\nRef No. 1000000000008\nSep 23, 2026 6:34 PM\n279g (gCO2e)\nBy going digital, you reduce your carbon footprint from\ntransportation, paper, and plastic.",
    "context": {
      "typedReference": "1000000000008",
      "expectedAmount": 800,
      "pricingAvailable": true,
      "amountTolerance": 0.01,
      "expectedRecipientName": "Jan Kennith Magallano",
      "expectedRecipientNumber": "09455107667",
      "bookingStartedAt": "2026-09-23T10:33:00.017Z",
      "bookingStartedDate": "2026-09-23",
      "paymentWindowMinutes": 15,
      "earlyToleranceMinutes": 2
    }
  }
];

for (const [index, fixture] of fixtures.entries()) {
  Deno.test(`audited wallet layout ${index + 1} (${fixture.provider}) passes dedicated evidence checks`, () => {
    const parsed = parseProviderReceipt(fixture.provider, fixture.raw, fixture.context);
    const result = verifyProviderReceipt(parsed, fixture.context);
    if (result.flags.length) throw Error(JSON.stringify(result.flags));
  });
}

const unionbank = fixtures.find(f => f.provider === "unionbank")!;
function checkUnionbank(raw = unionbank.raw, override = {}) {
  const context = { ...unionbank.context, ...override };
  return verifyProviderReceipt(parseProviderReceipt("unionbank", raw, context), context);
}
Deno.test("UnionBank completed timeline never borrows the submission time", () => {
  for (const raw of [
    unionbank.raw.replace("Successful\nSep 23, 2026 | 06:36 AM", "Successful"),
    unionbank.raw.replace("Successful\nSep 23, 2026 | 06:36 AM", "Successful\nSep 23, 2026 | 07:36 AM"),
    unionbank.raw.replace("Successful", "Pending"),
    unionbank.raw.replace("Successful\nSep 23, 2026 | 06:36 AM", "Successful\nSep 23, 2026 | 06:36 AM\nSep 23, 2026 | 06:37 AM"),
    unionbank.raw.replace("UB123456", "UB999999"),
    unionbank.raw.replace("PHP 1,100.00", "PHP 100.00"),
    unionbank.raw.replace("PaddleRage", "Other Merchant"),
  ]) {
    if (!checkUnionbank(raw).flags.length) throw Error("Unsafe timeline evidence passed");
  }
});
Deno.test("UnionBank receipt completion within payment window can cross Manila midnight", () => {
  const raw = unionbank.raw.replaceAll("Sep 23, 2026 | 06:36 AM", "Sep 23, 2026 | 12:03 AM");
  const result = checkUnionbank(raw, {bookingStartedAt: "2026-09-22T15:58:00Z", bookingStartedDate: "2026-09-22"});
  if (result.flags.length) throw Error(JSON.stringify(result.flags));
  if (!checkUnionbank(raw, {bookingStartedAt: "2026-09-22T15:00:00Z", bookingStartedDate: "2026-09-22"}).flags.includes("TIME_EXPIRED")) throw Error("Expired midnight payment accepted");
});


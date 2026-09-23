import { parseBpiToGcashReceipt, verifyBpiToGcashReceipt } from "./bpi.ts";
Deno.test("bpi precise window crosses midnight without widening window", () => {
  const raw =
    "18:10\nIll 5G\nTransfer successful!\nWednesday, Sep 23 2026; 12:01:00 AM (GMT +8)\nConfirmation No. 1626518942470\nTransaction Ref. No. 086535\nSent via BPI\nTransfer to\nGCash/G-Xchange\npaddle rage\n09455107667\nAdd to Favorites\nTransfer amount\nPHP 800.00\nFee\nPHP 0.00\n^ Hide other details\nTransfer from\nSAVINGS ACCOUNT\nXXXXXX0000 O\nNew transfer\nGo to Accounts";
  const context = {
    typedReference: "1626518942470",
    expectedAmount: 800,
    pricingAvailable: true,
    amountTolerance: .01,
    expectedRecipientName: "PaddleRage",
    expectedRecipientNumber: "09455107667",
    expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
    bookingStartedAt: "2026-09-22T15:58:00.000Z",
    bookingStartedDate: "2026-09-22",
    paymentWindowMinutes: 15,
    earlyToleranceMinutes: 2,
  };
  const parsed = parseBpiToGcashReceipt(raw, {
    typedReference: context.typedReference,
  });
  const valid = verifyBpiToGcashReceipt(parsed, context);
  if (valid.flags.length) throw Error(JSON.stringify(valid.flags));
  const late = verifyBpiToGcashReceipt(parsed, {
    ...context,
    bookingStartedAt: "2026-09-22T15:40:00.000Z",
  });
  if (
    !late.flags.includes("TIME_EXPIRED") ||
    !late.flags.includes("DATE_NOT_TODAY")
  ) throw Error("Out-of-window prior-day payment accepted");
});
import {
  parseBdoPayToGcashReceipt,
  verifyBdoPayToGcashReceipt,
} from "./bdopay.ts";
Deno.test("bdopay precise window crosses midnight without widening window", () => {
  const raw =
    "\nSent!\nPHP 1,600.00\nSep 23, 2026 12:01 AM\nAmount\nPHP 1,600.00\nService Fee\nPHP 0.00\nSend Money via InstaPay\nTo\nPaddleRage\nG-XCHANGE, INC. / GCASH\nDWQM4TK3JDO9O0NS8\nFrom\nTest Sender\n•••• •••• 5751\nInvoice number\n961119\nReference no.\nBN-20260923-69811640\n";
  const context = {
    typedReference: "BN2026092369811640",
    expectedAmount: 1600,
    pricingAvailable: true,
    amountTolerance: .01,
    expectedRecipientName: "PaddleRage",
    expectedRecipientNumber: "09455107667",
    expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
    bookingStartedAt: "2026-09-22T15:58:00.000Z",
    bookingStartedDate: "2026-09-22",
    paymentWindowMinutes: 15,
    earlyToleranceMinutes: 2,
  };
  const parsed = parseBdoPayToGcashReceipt(raw, {
    typedReference: context.typedReference,
  });
  const valid = verifyBdoPayToGcashReceipt(parsed, context);
  if (valid.flags.length) throw Error(JSON.stringify(valid.flags));
  const late = verifyBdoPayToGcashReceipt(parsed, {
    ...context,
    bookingStartedAt: "2026-09-22T15:40:00.000Z",
  });
  if (
    !late.flags.includes("TIME_EXPIRED") ||
    !late.flags.includes("DATE_NOT_TODAY")
  ) throw Error("Out-of-window prior-day payment accepted");
});
import { parseMayaToGcashReceipt, verifyMayaToGcashReceipt } from "./maya.ts";
Deno.test("maya precise window crosses midnight without widening window", () => {
  const raw =
    "\n12:04\nSent money via\n- ₱800.00\nInstaPay\nSep 23, 2026, 12:01 am\nYou may confirm the status of your transaction with your recipient.\nShare\npayment\nAccount type\nG-Xchange Inc. / GCash\nAccount number\n09455107667\nAccount name\nJ..KE....H M.\nTransfer Fee\n₱10.00\nReference ID\nB794 2F55 EC99\nInstaPay Ref. No\n797289\nmaya\nGet help\n";
  const context = {
    typedReference: "B7942F55EC99",
    expectedAmount: 800,
    pricingAvailable: true,
    amountTolerance: .01,
    expectedRecipientName: "Jan Kennith Magallano",
    expectedRecipientNumber: "09455107667",
    expectedRecipientAccount: "DWQM4TK3JDO9O0NS8",
    bookingStartedAt: "2026-09-22T15:58:00.000Z",
    bookingStartedDate: "2026-09-22",
    paymentWindowMinutes: 15,
    earlyToleranceMinutes: 2,
  };
  const parsed = parseMayaToGcashReceipt(raw, {
    typedReference: context.typedReference,
  });
  const valid = verifyMayaToGcashReceipt(parsed, context);
  if (valid.flags.length) throw Error(JSON.stringify(valid.flags));
  const late = verifyMayaToGcashReceipt(parsed, {
    ...context,
    bookingStartedAt: "2026-09-22T15:40:00.000Z",
  });
  if (
    !late.flags.includes("TIME_EXPIRED") ||
    !late.flags.includes("DATE_NOT_TODAY")
  ) throw Error("Out-of-window prior-day payment accepted");
});

import { isBdoRcbcDuplicate } from "./bdo-rcbc-decision.ts";
Deno.test("Only BDO to RCBC rejects confirmed reference or invoice reuse", () => {
  for (const flag of ["DUPLICATE_REF", "DUPLICATE_INVOICE"]) {
    if (!isBdoRcbcDuplicate("rcbc", "bdo_to_rcbc_v1", [flag])) throw Error(flag);
    for (const [provider, version] of [["bdopay", "bdopay_to_gcash_v1"], ["rcbc", "bpi_to_rcbc_v1"], ["rcbc", "gotyme_to_rcbc_v1"], ["gcash", "gcash_v1"]]) {
      if (isBdoRcbcDuplicate(provider, version, [flag])) throw Error("Other route changed");
    }
  }
});
Deno.test("Nonduplicate BDO failures stay in review", () => {
  for (const flag of ["AMOUNT_MISMATCH", "TIME_EXPIRED", "TIME_FUTURE", "DATE_NOT_TODAY", "RECEIVER_ACCOUNT_MISMATCH", "LOW_OCR_CONFIDENCE", "RCBC_DUPLICATE_CHECK_UNAVAILABLE"]) {
    if (isBdoRcbcDuplicate("rcbc", "bdo_to_rcbc_v1", [flag])) throw Error(flag);
  }
  if (isBdoRcbcDuplicate("rcbc", "bdo_to_rcbc_v1", [])) throw Error("Clean receipt rejected");
});

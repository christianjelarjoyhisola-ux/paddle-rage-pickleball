// Rejection is restricted to confirmed transaction/invoice reuse on BDO -> RCBC.
// OCR, pricing, timing and lookup failures remain pending for human review.
export function isBdoRcbcDuplicate(
  provider: string,
  sourceParserVersion: string | undefined,
  flags: string[],
): boolean {
  return provider === "rcbc" && sourceParserVersion === "bdo_to_rcbc_v1" &&
    flags.some((flag) => flag === "DUPLICATE_REF" || flag === "DUPLICATE_INVOICE");
}

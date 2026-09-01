import {
  calculateCourtPayment,
  classifyStoredSessionPayment,
} from "./booking-payment.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

const base = {
  slots: [17, 18],
  courtRate: 400,
  feeRate: 20,
  feeType: "per_hour",
  paymentAcceptanceMode: "both",
};

Deno.test("regular booking requires full payment", () => {
  const amounts = calculateCourtPayment({ ...base, storedDownpayment: 800 });
  assertEquals(amounts.courtTotal, 760, "court total");
  assertEquals(amounts.serviceFee, 40, "service fee");
  assertEquals(amounts.total, 800, "booking total");
  assertEquals(amounts.due, 800, "regular full payment");
});

Deno.test("regular booking rejects a partial payment", () => {
  assertThrows(
    () => calculateCourtPayment({ ...base, storedDownpayment: 420 }),
    "regular partial payment should be rejected",
  );
});

Deno.test("host due is 25% of court charges plus the full service fee", () => {
  const amounts = calculateCourtPayment({
    ...base,
    storedDownpayment: 230,
    hostBooking: true,
  });
  assertEquals(amounts.due, 230, "host downpayment");
});

Deno.test("host booking still permits full payment when stored that way", () => {
  const amounts = calculateCourtPayment({
    ...base,
    storedDownpayment: 800,
    hostBooking: true,
  });
  assertEquals(amounts.due, 800, "host full payment");
});

Deno.test("booking fee aliases are treated as one flat fee", () => {
  const amounts = calculateCourtPayment({
    ...base,
    feeType: "per_booking",
    storedDownpayment: 215,
    hostBooking: true,
  });
  assertEquals(amounts.serviceFee, 20, "flat booking fee");
  assertEquals(amounts.due, 215, "host due with flat booking fee");
});

Deno.test("host stored downpayment must match the recomputed host due", () => {
  assertThrows(
    () =>
      calculateCourtPayment({
        ...base,
        // This does not include the full private allocation.
        storedDownpayment: 210,
        hostBooking: true,
      }),
    "invalid host downpayment should be rejected",
  );
});

Deno.test("grouped host dues add the full fee for every booking row", () => {
  const first = calculateCourtPayment({
    ...base,
    slots: [17, 18],
    storedDownpayment: 230,
    hostBooking: true,
  });
  const second = calculateCourtPayment({
    ...base,
    slots: [19],
    storedDownpayment: 115,
    hostBooking: true,
  });
  assertEquals(first.due + second.due, 345, "group host due");
  assertEquals(first.total + second.total, 1200, "group total");
});

Deno.test("stored partial checkout becomes downpayment paid", () => {
  const status = classifyStoredSessionPayment(230, [{
    total: 800,
    downpayment: 230,
    hostBooking: true,
  }]);
  assertEquals(status, "downpayment_paid", "partial checkout status");
});

Deno.test("stored full checkout becomes fully paid", () => {
  const status = classifyStoredSessionPayment(800, [{
    total: 800,
    downpayment: 800,
  }]);
  assertEquals(status, "paid", "full checkout status");
});

Deno.test("stored grouped checkout sums every active booking row", () => {
  const status = classifyStoredSessionPayment(345, [
    { total: 800, downpayment: 230, hostBooking: true },
    { total: 400, downpayment: 115, hostBooking: true },
  ]);
  assertEquals(status, "downpayment_paid", "group checkout status");
});

Deno.test("webhook payment cannot override the stored session amount", () => {
  assertThrows(
    () =>
      classifyStoredSessionPayment(210, [{
        total: 800,
        downpayment: 230,
      }]),
    "mismatched session amount should be rejected",
  );
});

Deno.test("regular checkout cannot become a partial-payment booking", () => {
  assertThrows(
    () =>
      classifyStoredSessionPayment(420, [{
        total: 800,
        downpayment: 420,
        hostBooking: false,
      }]),
    "regular partial checkout should be rejected",
  );
});

Deno.test("historical additive totals keep their immutable stored snapshot", () => {
  const amounts = calculateCourtPayment({
    ...base,
    slots: [17],
    feeRate: 99,
    storedTotal: 410,
    storedServiceFee: 10,
    storedDownpayment: 410,
  });
  assertEquals(amounts.courtTotal, 400, "historical court share");
  assertEquals(amounts.serviceFee, 10, "historical fee snapshot");
  assertEquals(amounts.total, 410, "historical player total");
  assertEquals(amounts.due, 410, "historical amount due");
});

Deno.test("an explicit zero fee snapshot never falls back to today's fee", () => {
  const amounts = calculateCourtPayment({
    ...base,
    slots: [17],
    feeRate: 99,
    storedTotal: 400,
    storedServiceFee: 0,
    storedDownpayment: 400,
  });
  assertEquals(amounts.courtTotal, 400, "zero-snapshot court share");
  assertEquals(amounts.serviceFee, 0, "zero snapshot");
  assertEquals(amounts.total, 400, "zero-snapshot total");
});

import {
  activeReceiptRole,
  bookingAccessTokenMatches,
  canViewBookingReceipt,
  canViewDashboardReceipt,
  canViewHostSessionReceipt,
  isBookingAccessToken,
  sha256TextHex,
} from "./receipt-access.ts";

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("booking access tokens require the exact generated format and digest", async () => {
  const token = "ab".repeat(32);
  const hash = await sha256TextHex(token);

  assert(isBookingAccessToken(token));
  assert(!isBookingAccessToken("AB".repeat(32)));
  assert(!isBookingAccessToken("ab".repeat(31)));
  assert(await bookingAccessTokenMatches(token, hash));
  assert(!(await bookingAccessTokenMatches("cd".repeat(32), hash)));
  assert(!(await bookingAccessTokenMatches(token, "not-a-hash")));
});

Deno.test("only active dashboard roles can view unrestricted receipts", () => {
  for (const role of ["owner", "court_owner", "staff"]) {
    assert(canViewDashboardReceipt({ role, status: "active" }));
  }
  assert(!canViewDashboardReceipt({ role: "owner", status: "suspended" }));
  assert(!canViewDashboardReceipt({ role: "host", status: "active" }));
  assert(activeReceiptRole({ role: "STAFF", status: "ACTIVE" }) === "staff");
});

Deno.test("an active host can view only their own host-booking receipt", () => {
  const account = { role: "host", status: "active" };
  const own = {
    host_booking: true,
    host_user_id: "host-1",
    created_by_user_id: "host-1",
  };

  assert(canViewBookingReceipt(account, "host-1", own));
  assert(!canViewBookingReceipt(account, "host-2", own));
  assert(
    !canViewBookingReceipt(account, "host-1", { ...own, host_booking: false }),
  );
  assert(
    !canViewBookingReceipt(
      { role: "host", status: "suspended" },
      "host-1",
      own,
    ),
  );
});

Deno.test("an active host can view only registrations for their own session", () => {
  const account = { role: "host", status: "active" };
  assert(
    canViewHostSessionReceipt(account, "host-1", { host_user_id: "host-1" }),
  );
  assert(
    !canViewHostSessionReceipt(account, "host-1", { host_user_id: "host-2" }),
  );
  assert(
    !canViewHostSessionReceipt({ role: "host", status: "pending" }, "host-1", {
      host_user_id: "host-1",
    }),
  );
});

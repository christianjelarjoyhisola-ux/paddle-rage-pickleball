import {
  claimBalanceNotification,
  finishBalanceNotification,
} from "./balance-notification-lease.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("balance notice claim passes the bounded lease and returns its owner token", async () => {
  let calledName = "";
  let calledArgs: Record<string, unknown> = {};
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      calledName = name;
      calledArgs = args;
      return {
        data: {
          acquired: true,
          id: "7d54c5a4-9819-462d-baf1-351a7b465df6",
          claimToken: "879e067c-80f5-4d82-a1d3-7d98361e55fb",
          attemptCount: 2,
          leaseExpiresAt: "2026-07-19T03:05:00Z",
        },
        error: null,
      };
    },
  };

  const claim = await claimBalanceNotification(db, {
    bookingKey: "PR-001",
    bookingRef: "PR-001-A",
    eventType: "reminder_1d",
    recipientEmail: "host@example.com",
    leaseSeconds: 5_000,
  });

  assert(
    calledName === "claim_booking_balance_notification",
    "wrong claim RPC",
  );
  assert(
    calledArgs.p_lease_seconds === 900,
    "client lease maximum was not enforced",
  );
  assert(claim.acquired, "claim should be acquired");
  assert(
    claim.claimToken === "879e067c-80f5-4d82-a1d3-7d98361e55fb",
    "claim token missing",
  );
  assert(claim.attemptCount === 2, "attempt count missing");
});

Deno.test("active delivery lease is returned as a non-error skip", async () => {
  const db = {
    async rpc() {
      return {
        data: {
          acquired: false,
          id: "7d54c5a4-9819-462d-baf1-351a7b465df6",
          reason: "lease_active",
          leaseExpiresAt: "2026-07-19T03:05:00Z",
        },
        error: null,
      };
    },
  };

  const claim = await claimBalanceNotification(db, {
    bookingKey: "PR-001",
    bookingRef: "PR-001-A",
    eventType: "reminder_1d",
    recipientEmail: "host@example.com",
  });

  assert(!claim.acquired, "overlapping worker must not acquire the lease");
  assert(
    claim.reason === "lease_active",
    "active lease reason was not preserved",
  );
});

Deno.test("completion sends both id and owner token to the guarded RPC", async () => {
  let calledArgs: Record<string, unknown> = {};
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      assert(
        name === "finish_booking_balance_notification",
        "wrong completion RPC",
      );
      calledArgs = args;
      return { data: true, error: null };
    },
  };

  const completed = await finishBalanceNotification(db, {
    id: "7d54c5a4-9819-462d-baf1-351a7b465df6",
    claimToken: "879e067c-80f5-4d82-a1d3-7d98361e55fb",
    outcome: "sent",
    providerMessageId: "c843204e3af03193bd14f339",
  });

  assert(completed, "owned completion should succeed");
  assert(
    calledArgs.p_notification_id === "7d54c5a4-9819-462d-baf1-351a7b465df6",
    "notification id missing",
  );
  assert(
    calledArgs.p_claim_token === "879e067c-80f5-4d82-a1d3-7d98361e55fb",
    "owner token missing",
  );
  assert(calledArgs.p_outcome === "sent", "completion outcome missing");
});

Deno.test("lost claim ownership is reported without treating completion as successful", async () => {
  const db = {
    async rpc() {
      return { data: false, error: null };
    },
  };
  const completed = await finishBalanceNotification(db, {
    id: "7d54c5a4-9819-462d-baf1-351a7b465df6",
    claimToken: "879e067c-80f5-4d82-a1d3-7d98361e55fb",
    outcome: "failed",
    errorMessage: "provider unavailable",
  });
  assert(
    !completed,
    "a stale worker must not finalize another worker's attempt",
  );
});

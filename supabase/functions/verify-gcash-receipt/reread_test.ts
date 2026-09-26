// Exercise the actual handler with isolated HTTP doubles. No real network or database writes.
// Run: deno test --no-check --no-lock --allow-env --import-map=supabase/functions/verify-gcash-receipt/reread-test-importmap.json supabase/functions/verify-gcash-receipt/reread_test.ts
let handler: (request: Request) => Promise<Response>;
const originalServe = Deno.serve;
Deno.serve = ((fn: typeof handler) => {
  handler = fn;
  return {};
}) as typeof Deno.serve;
await import("./index.ts");
Deno.serve = originalServe;
const assert = (value: unknown, message: string) => {
  if (!value) throw Error(message);
};

Deno.test("owner rereads use stored evidence, preserve terminal payments and require authorization", async (t) => {
  const fetchOriginal = globalThis.fetch;
  const envKeys = ["SUPABASE_URL", "SERVICE_ROLE_KEY"];
  const oldEnv = envKeys.map((key) => Deno.env.get(key));
  Deno.env.set("SUPABASE_URL", "https://receipt-test.invalid");
  Deno.env.set("SERVICE_ROLE_KEY", "test-service-key");
  let role = "owner",
    status = "pending",
    claimed = true,
    afterLeaseResolved = false,
    reads = 0;
  const calls: string[] = [];
  const hash = "a".repeat(64), path = `PB-TEST/${hash}.png`;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert(
      url.hostname === "receipt-test.invalid",
      "Unexpected real network request",
    );
    calls.push(url.pathname);
    const reply = (body: unknown, code = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: code,
          headers: { "Content-Type": "application/json" },
        }),
      );
    if (url.pathname === "/auth/v1/user") return reply({ id: "owner-test" });
    if (url.pathname === "/rest/v1/accounts") {
      return reply({ role, status: "active" });
    }
    if (url.pathname === "/rest/v1/bookings") {
      reads++;
      return reply({
        ref: "PB-TEST",
        status: afterLeaseResolved && reads > 1 ? "confirmed" : status,
        payment_status: "for_verification",
        payment_method: "rcbc",
        receipt_status: "manual_review",
        receipt_verified_at: "2026-09-26T01:00:00Z",
        receipt_image_hash: hash,
        receipt_image_url: path,
      });
    }
    if (url.pathname.endsWith("/public_payment_method_ready")) {
      return reply(true);
    }
    if (url.pathname.endsWith("/claim_receipt_verification_lease")) {
      return reply([{ claimed, claim_token: "test-token" }]);
    }
    if (url.pathname.endsWith("/release_receipt_verification_lease")) {
      return reply(true);
    }
    if (url.pathname.startsWith("/storage/v1/object/")) {
      assert(
        url.pathname.endsWith(path),
        "Must download the server-stored image",
      );
      return reply({ message: "Test stops before OCR" }, 404);
    }
    throw Error("Unexpected request: " + url.pathname);
  }) as typeof fetch;
  const request = () =>
    handler(
      new Request("https://edge-test.invalid", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-user",
        },
        body: JSON.stringify({
          action: "reread",
          bookingRef: "PB-TEST",
          stagedReceiptPath: "attacker/image.png",
          imageBase64: "replacement",
        }),
      }),
    );
  const reset = () => {
    calls.length = 0;
    reads = 0;
    role = "owner";
    status = "pending";
    claimed = true;
    afterLeaseResolved = false;
  };
  try {
    await t.step(
      "owner reruns a previously checked pending receipt using its saved image",
      async () => {
        reset();
        const r = await request();
        assert(r.status === 409, "Expected the mocked missing-object result");
        assert(
          calls.some((p) => p.startsWith("/storage/v1/object/")),
          "Cached result must not bypass a reread",
        );
      },
    );
    await t.step("staff cannot trigger a reread", async () => {
      reset();
      role = "staff";
      assert((await request()).status === 403, "Staff must be denied");
      assert(
        !calls.some((p) => p.includes("/rpc/") || p.includes("/storage/")),
        "No billable or mutating work before permission check",
      );
    });
    await t.step("resolved bookings remain unchanged", async () => {
      reset();
      status = "confirmed";
      assert(
        (await request()).status === 409,
        "Resolved receipt must be denied",
      );
      assert(
        !calls.some((p) => p.includes("/rpc/")),
        "No lease for a resolved receipt",
      );
    });
    await t.step("concurrent rereads respect the existing lease", async () => {
      reset();
      claimed = false;
      assert((await request()).status === 409, "Busy receipt must be denied");
      assert(
        !calls.some((p) => p.includes("/storage/")),
        "Busy receipt must not run OCR",
      );
    });
    await t.step(
      "confirmation during lease acquisition remains protected",
      async () => {
        reset();
        afterLeaseResolved = true;
        assert(
          (await request()).status === 409,
          "New terminal state must be respected",
        );
        assert(
          !calls.some((p) => p.includes("/storage/")),
          "No reread after confirmation",
        );
      },
    );
  } finally {
    globalThis.fetch = fetchOriginal;
    envKeys.forEach((key, i) =>
      oldEnv[i] === undefined
        ? Deno.env.delete(key)
        : Deno.env.set(key, oldEnv[i]!)
    );
  }
});

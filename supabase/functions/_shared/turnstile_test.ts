import {
  normalizeClientIp,
  parseTurnstileHostnames,
  RECEIPT_OCR_TURNSTILE_ACTION,
  TURNSTILE_SITEVERIFY_URL,
  turnstileRemoteIp,
  verifyTurnstileToken,
} from "./turnstile.ts";

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Turnstile posts the token, secret, idempotency key, and remote IP", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetcher = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          success: true,
          action: RECEIPT_OCR_TURNSTILE_ACTION,
          hostname: "paddleragecdo.ph",
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  const result = await verifyTurnstileToken({
    token: "fresh-widget-token",
    secret: "server-secret",
    remoteIp: "203.0.113.42",
    allowedHostnames: ["paddleragecdo.ph"],
    idempotencyKey: "test-idempotency-key",
    fetcher,
  });

  assert(result.ok, "expected a valid Turnstile result");
  assert(
    requestedUrl === TURNSTILE_SITEVERIFY_URL,
    "must call official siteverify",
  );
  assert(requestedInit?.method === "POST", "must POST siteverify");
  assert(
    requestedInit?.headers &&
      new Headers(requestedInit.headers).get("Content-Type") ===
        "application/x-www-form-urlencoded",
    "must use an encoded form body",
  );
  const form = new URLSearchParams(String(requestedInit?.body || ""));
  assert(form.get("secret") === "server-secret");
  assert(form.get("response") === "fresh-widget-token");
  assert(form.get("remoteip") === "203.0.113.42");
  assert(form.get("idempotency_key") === "test-idempotency-key");
});

Deno.test("Turnstile rejects missing and oversized tokens without a network call", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls += 1;
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;

  const missing = await verifyTurnstileToken({
    token: "",
    secret: "server-secret",
    fetcher,
  });
  const oversized = await verifyTurnstileToken({
    token: "x".repeat(2049),
    secret: "server-secret",
    fetcher,
  });
  const misconfigured = await verifyTurnstileToken({
    token: "fresh-token",
    secret: "",
    fetcher,
  });

  assert(!missing.ok && missing.reason === "missing-token");
  assert(!oversized.ok && oversized.reason === "invalid-token");
  assert(
    !misconfigured.ok && misconfigured.reason === "server-misconfigured",
  );
  assert(calls === 0, "invalid local input must not call siteverify");
});

Deno.test("Turnstile rejects expired or replayed tokens", async () => {
  const result = await verifyTurnstileToken({
    token: "already-used-token",
    secret: "server-secret",
    fetcher: (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: false,
            "error-codes": ["timeout-or-duplicate"],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch,
  });

  assert(!result.ok && result.reason === "invalid-token");
  assert(result.errorCodes.includes("timeout-or-duplicate"));
});

Deno.test("Turnstile binds tokens to the OCR action and configured hostname", async () => {
  const response = (action: string, hostname: string) =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, action, hostname }), {
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;

  const wrongAction = await verifyTurnstileToken({
    token: "token-one",
    secret: "secret",
    allowedHostnames: ["paddleragecdo.ph"],
    fetcher: response("some_other_action", "paddleragecdo.ph"),
  });
  const wrongHost = await verifyTurnstileToken({
    token: "token-two",
    secret: "secret",
    allowedHostnames: ["paddleragecdo.ph"],
    fetcher: response(RECEIPT_OCR_TURNSTILE_ACTION, "attacker.example"),
  });

  assert(!wrongAction.ok && wrongAction.errorCodes.includes("action-mismatch"));
  assert(!wrongHost.ok && wrongHost.errorCodes.includes("hostname-mismatch"));
});

Deno.test("Turnstile client IP and hostname configuration are sanitized", () => {
  assert(normalizeClientIp("203.0.113.9, 10.0.0.1") === "203.0.113.9");
  assert(normalizeClientIp("2001:db8::1234") === "2001:db8::1234");
  assert(normalizeClientIp("999.1.1.1") === "");
  assert(normalizeClientIp("203.0.113.9 attacker") === "");

  const req = new Request("https://example.test", {
    headers: {
      "cf-connecting-ip": "203.0.113.11",
      "x-forwarded-for": "198.51.100.7, 10.0.0.1",
    },
  });
  assert(turnstileRemoteIp(req) === "203.0.113.11");
  const hosts = parseTurnstileHostnames(
    "paddleragecdo.ph, WWW.PADDLERAGECDO.PH., https://invalid.example/path",
  );
  assert(hosts.length === 2);
  assert(hosts.includes("www.paddleragecdo.ph"));
});

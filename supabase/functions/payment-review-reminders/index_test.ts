import { handle, reminderMessage, sendReminder } from "./index.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("reminders identify the payment, escape text, and link to the review queue", () => {
  const message = reminderMessage({ kind: "host_balance", reference: "PB-<test>&", amount: 877.5, booker_name: "KC <Test> & Co",
    pending_since: "2026-10-09T10:00:00Z" }, Date.parse("2026-10-09T11:05:00Z"));
  assert(message.includes("Host balance payment"));
  assert(message.includes("PB-&lt;test&gt;&amp;"));
  assert(message.includes("Booker: <b>KC &lt;Test&gt; &amp; Co</b>"));
  assert(message.includes("₱877.50"));
  assert(message.includes("1h 5m"));
  assert(message.includes("admin#payreview"));
});

Deno.test("missing booker names are labelled without inventing a name", () => {
  const message = reminderMessage({ kind: "booking", reference: "TEST", amount: 100,
    pending_since: "2026-10-09T10:00:00Z", booker_name: "  " });
  assert(message.includes("Booker: <b>Name unavailable</b>"));
});

Deno.test("Telegram delivery requires HTTP and application-level success", async () => {
  for (const [status, ok, expected] of [[200, true, true], [200, false, false], [429, false, false]] as const) {
    const delivered = await sendReminder("test-token", "test-chat", "test-message", ((_url, init) => {
      const payload = JSON.parse(String(init?.body));
      assert(payload.chat_id === "test-chat");
      assert(init?.signal);
      return Promise.resolve(Response.json({ ok }, { status }));
    }) as typeof fetch);
    assert(delivered === expected);
  }
});

Deno.test("public requests cannot trigger Telegram reminders", async () => {
  assert((await handle(new Request("https://example.com", { method: "GET" }))).status === 405);
  assert((await handle(new Request("https://example.com", { method: "POST" }))).status === 401);
  assert((await handle(new Request("https://example.com", { method: "POST", headers: { "x-cron-secret": "bad" } }))).status === 401);
});

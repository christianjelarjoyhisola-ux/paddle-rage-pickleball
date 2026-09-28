// deno-lint-ignore-file no-explicit-any
import { requestHostPasswordRecovery } from "./host-password-recovery.ts";

function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
function fixture(options: Record<string, any> = {}) {
  const calls: string[] = [];
  const filters: Record<string, string> = {};
  const account = options.missing ? null : { id: "host-a", email: "host@example.com" };
  const query: any = {
    select() { return query; },
    eq(key: string, value: string) { filters[key] = value; return query; },
    maybeSingle() { return { data: account, error: options.lookupError }; },
  };
  const db = {
    from(table: string) { assert(table === "accounts", "only query accounts"); return query; },
    rpc(name: string, params: any) {
      calls.push("claim");
      assert(name === "claim_host_password_recovery" && params.p_account_id === "host-a", "claim authenticated account identity");
      return { data: options.claimed !== false, error: options.claimError };
    },
    auth: { admin: {
      getUserById(id: string) {
        assert(id === "host-a", "lookup correct user");
        return { data: { user: { id, email: options.otherEmail || "host@example.com", email_confirmed_at: options.unverified ? null : "2026-09-01", banned_until: options.banned ? "2999-01-01" : null } } };
      },
      generateLink(args: any) {
        calls.push("link");
        assert(args.type === "recovery", "never create a login/signup link");
        assert(args.options.redirectTo === "https://paddleragecdo.ph/host.html?recovery=1", "fixed host reset destination");
        return { data: { user: { id: options.wrongId ? "other" : "host-a" }, properties: { action_link: "https://auth.example/verify?token=test&type=recovery" } }, error: options.linkError };
      },
    } },
  };
  const send = async (mail: any) => {
    calls.push("send");
    assert(mail.to === "host@example.com", "deliver only to verified host email");
    assert(mail.html.includes("&amp;type=recovery"), "escape link HTML");
    const links = [...mail.html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
    assert(links.length === 2, "include a real clickable button and fallback link");
    assert(links[0][2] === "Reset Password", "label the button clearly");
    assert(links.every(link => link[1] === "https://auth.example/verify?token=test&amp;type=recovery"), "both links must open the generated recovery URL");
    assert(mail.plain.includes("type=recovery"), "provide plain text link");
    return { id: "test-delivery" };
  };
  return { db, send, calls, filters };
}

Deno.test("host reset mails an expiring recovery link only after the persistent claim", async () => {
  const f = fixture();
  const result = await requestHostPasswordRecovery(f.db, "host@example.com", "https://paddleragecdo.ph/", f.send);
  assert(result === undefined, "never return the secret link to the browser");
  assert(f.calls.join() === "claim,link,send", "claim before minting or sending");
  assert(f.filters.role === "host" && f.filters.status === "active", "exclude inactive and non-host accounts");
});
for (const options of [{ missing: true }, { unverified: true }, { banned: true }, { otherEmail: "other@example.com" }, { claimed: false }]) {
  Deno.test(`host reset does not send for ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await requestHostPasswordRecovery(f.db, "host@example.com", "https://paddleragecdo.ph", f.send);
    assert(!f.calls.includes("link") && !f.calls.includes("send"), "no token or mail when ineligible");
  });
}
for (const options of [{ lookupError: true }, { claimError: true }, { linkError: true }, { wrongId: true }]) {
  Deno.test(`host reset fails closed for ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    let rejected = false;
    try { await requestHostPasswordRecovery(f.db, "host@example.com", "https://paddleragecdo.ph", f.send); } catch (_) { rejected = true; }
    assert(rejected && !f.calls.includes("send"), "reject without mail on identity or backend failure");
  });
}

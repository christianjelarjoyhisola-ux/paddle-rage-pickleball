import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    const raw = await req.text();
    if (raw.length > 16384) return reply({ error: "Request too large" }, 413);
    const body = JSON.parse(raw);
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: userData } = bearer ? await db.auth.getUser(bearer) : { data: { user: null } };
    const actor = userData?.user?.id || null;
    const action = String(body.action || "");
    if (body.admin === true) {
      if (!actor) return reply({ error: "Sign in as an owner" }, 401);
      const { data, error } = await db.rpc("voucher_admin", { p_actor: actor, p_action: action, p_data: body.data || {} });
      if (error) return reply({ error: error.message }, 400);
      return reply(data);
    }
    const ref = String(body.ref || "").trim();
    const accessToken = String(body.accessToken || "");
    if (!ref || ref.length > 100 || (!actor && !/^[0-9a-f]{64}$/i.test(accessToken))) return reply({ error: "Secure booking access is required" }, 401);
    if (["preview", "apply"].includes(action)) {
      // Limit by IP as well as identity: generating fresh guest holds must not
      // bypass the code-guessing limit. Only keyed hashes are persisted.
      const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      for (const key of ["ip:" + ip, "identity:" + (actor || accessToken)]) {
        const { data, error } = await db.rpc("voucher_attempt", { p_key: await digest(key) });
        if (error || data !== true) return reply({ error: "Too many voucher attempts. Try again in 10 minutes." }, 429);
      }
    }
    const { data, error } = await db.rpc("voucher_checkout", {
      p_action: action, p_ref: ref, p_code: String(body.code || "").slice(0, 40),
      p_token_hash: accessToken ? await digest(accessToken.toLowerCase()) : null,
      p_actor: actor, p_contact: body.contact || {},
    });
    if (error) return reply({ error: error.message }, 409);
    return reply(data);
  } catch {
    return reply({ error: "Voucher request could not be processed" }, 400);
  }
});

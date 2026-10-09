import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const labels: Record<string, string> = {
  booking: "Court booking / host deposit", host_balance: "Host balance payment",
  open_play: "Open Play payment", host_session: "Hosted Open Play payment",
};
const escape = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function reminderMessage(payment: { kind: string; reference: string; amount: number; pending_since: string; booker_name?: string | null }, now = Date.now()) {
  const minutes = Math.max(60, Math.floor((now - Date.parse(payment.pending_since)) / 60000));
  return `⏰ <b>Payment still awaiting review</b>\n\n` +
    `${escape(labels[payment.kind] || payment.kind)}\n` +
    `Booker: <b>${escape(payment.booker_name?.trim() || "Name unavailable")}</b>\n` +
    `Booking: <code>${escape(payment.reference)}</code>\n` +
    `Amount: <b>₱${Number(payment.amount).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>\n` +
    `Waiting: ${Math.floor(minutes / 60)}h ${minutes % 60}m\n\n` +
    `<a href="https://paddleragecdo.ph/admin#payreview">Review payment</a>\n` +
    `Reminders repeat hourly until this payment is reviewed.`;
}

export async function sendReminder(token: string, chatId: string, message: string, send = fetch) {
  const response = await send(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000),
  });
  const result = await response.json();
  return response.ok && result.ok === true;
}

export async function handle(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = req.headers.get("x-cron-secret") || "";
  if (secret.length < 32 || secret.length > 256) return json({ error: "Unauthorized" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const auth = await db.rpc("verify_balance_cron_secret", { p_token: secret });
  if (auth.error || auth.data !== true) return json({ error: "Unauthorized" }, 401);
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  const recipients = [...new Set((Deno.env.get("TELEGRAM_CHAT_ID") || "").split(",").map(s => s.trim()).filter(Boolean))];
  if (!token || !recipients.length) return json({ error: "Telegram not configured" }, 503);
  let sent = 0, failed = 0, skipped = 0;
  try {
    for (const recipient of recipients) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${token}:${recipient}`));
      const recipientKey = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      const due = await db.rpc("due_payment_review_reminders", { p_recipient_key: recipientKey });
      if (due.error) throw due.error;
      for (const payment of due.data || []) {
        const args = { p_kind: payment.kind, p_subject_id: payment.subject_id, p_recipient_key: recipientKey };
        const claim = await db.rpc("claim_payment_review_reminder", args);
        if (claim.error) throw claim.error;
        if (!claim.data) { skipped++; continue; }
        // Recheck after acquiring the lease so a just-reviewed payment is skipped.
        const current = await db.from("payment_review_reminder_candidates").select("*")
          .eq("kind", payment.kind).eq("subject_id", payment.subject_id).maybeSingle();
        let delivered = false;
        if (!current.error && current.data) {
          try { delivered = await sendReminder(token, recipient, reminderMessage(current.data)); }
          catch { /* Keep credentials out of logs; retry after the lease cooldown. */ }
          if (delivered) sent++; else failed++;
        } else if (current.error) { failed++; } else { skipped++; }
        const done = await db.rpc("finish_payment_review_reminder", { ...args, p_token: claim.data, p_sent: delivered });
        if (done.error || done.data !== true) throw new Error("Reminder delivery tracking failed");
      }
    }
    return json({ ok: failed === 0, sent, failed, skipped });
  } catch {
    return json({ ok: false, sent, failed, skipped, error: "Reminder processing failed" }, 500);
  }
}

if (import.meta.main) Deno.serve(handle);

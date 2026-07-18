import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_EVENTS = new Set([
  "new_booking",
  "booking_confirmed",
  "booking_rescheduled",
  "booking_cancelled",
  "booking_forfeited",
  "payment_verified",
  "payment_rejected",
  "payment_review_needed",
  "admin_booking_created",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function text(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtPHP(value: unknown): string {
  return `PHP ${
    Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

function fmtDate(value: unknown): string {
  const raw = text(value, 10);
  const date = new Date(`${raw}T00:00:00+08:00`);
  if (!raw || Number.isNaN(date.getTime())) return raw || "—";
  return date.toLocaleDateString("en-PH", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Manila",
  });
}

function eventLabel(event: string): string {
  const labels: Record<string, string> = {
    new_booking: "NEW BOOKING",
    booking_confirmed: "BOOKING CONFIRMED",
    booking_rescheduled: "BOOKING RESCHEDULED",
    booking_cancelled: "BOOKING CANCELLED",
    booking_forfeited: "BOOKING FORFEITED",
    payment_verified: "PAYMENT VERIFIED",
    payment_rejected: "PAYMENT REJECTED",
    payment_review_needed: "PAYMENT NEEDS REVIEW",
    admin_booking_created: "ADMIN BOOKING CREATED",
  };
  return labels[event] || "BOOKING UPDATE";
}

function eventMatchesCanonicalState(
  event: string,
  rows: Record<string, unknown>[],
  privileged: boolean,
): boolean {
  if (!rows.length) return false;
  if (privileged) return true;

  const everyStatus = (...allowed: string[]) =>
    rows.every((row) => allowed.includes(text(row.status, 30).toLowerCase()));
  const everyPayment = (...allowed: string[]) =>
    rows.every((row) =>
      allowed.includes(text(row.payment_status, 30).toLowerCase())
    );

  switch (event) {
    case "new_booking":
      return everyStatus("verifying", "pending", "confirmed", "completed") &&
        !rows.some((row) =>
          text(row.payment_status, 30).toLowerCase() === "rejected"
        );
    case "booking_confirmed":
      return everyStatus("confirmed", "completed");
    case "booking_cancelled":
      return everyStatus("cancelled");
    case "booking_forfeited":
      return everyStatus("forfeited");
    case "payment_verified":
      return everyPayment("paid", "downpayment_paid", "deposit_retained");
    case "payment_rejected":
      return everyPayment("rejected") || everyStatus("cancelled");
    case "payment_review_needed":
      return everyPayment("pending", "for_verification");
    // Reschedule provenance and admin-created provenance cannot be established
    // from the current booking row, so only a trusted dashboard role may emit
    // these event types.
    case "booking_rescheduled":
    case "admin_booking_created":
    default:
      return false;
  }
}

function adminUrl(): string {
  return Deno.env.get("APP_ADMIN_URL") ||
    "https://paddleragecdo.ph/admin.html";
}

function bookingMessage(
  rows: Record<string, unknown>[],
  event: string,
): string {
  const primary = rows[0] || {};
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const paid = rows.reduce(
    (sum, row) =>
      sum +
      Number(row.payment_status === "paid" ? row.total : row.downpayment || 0),
    0,
  );
  const courts = [
    ...new Set(rows.map((row) => text(row.court_name, 150)).filter(Boolean)),
  ]
    .join(", ");
  const displayRef = text(primary.booking_group_ref, 100) ||
    text(primary.ref, 100);
  const method = text(primary.payment_method || "cash", 30).toUpperCase();
  const paymentRef = text(primary.gcash_ref, 100);

  return (
    `<b>${esc(eventLabel(event))}</b>\n` +
    `------------------\n` +
    `<b>${esc(primary.full_name)}</b>\n` +
    `${esc(primary.contact_number || "")}\n\n` +
    `<b>${esc(courts || primary.court_name)}</b>\n` +
    `${esc(fmtDate(primary.date))}\n` +
    `${esc(primary.start_time)} - ${esc(primary.end_time)}` +
    (rows.length > 1 ? ` · ${rows.length} reservations` : "") +
    `\n\nPayment: <b>${esc(method)}</b>` +
    (paymentRef ? `\nPayment ref: <code>${esc(paymentRef)}</code>` : "") +
    `\nTotal: ${fmtPHP(total)}` +
    `\nPaid / DP: <b>${fmtPHP(paid)}</b>` +
    `\nPayment status: <b>${esc(primary.payment_status)}</b>` +
    `\nBooking status: <b>${esc(primary.status)}</b>` +
    `\n\nBooking ref: <code>${esc(displayRef)}</code>\n` +
    `------------------\n` +
    `<a href="${adminUrl()}">Open the Paddle Rage dashboard.</a>`
  );
}

async function sendTelegram(message: string): Promise<Record<string, unknown>> {
  const botToken = text(Deno.env.get("TELEGRAM_BOT_TOKEN"), 500);
  const chatIds = text(Deno.env.get("TELEGRAM_CHAT_ID"), 1000)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!botToken || !chatIds.length) {
    return { ok: true, skipped: true, reason: "Telegram not configured" };
  }

  const results = await Promise.allSettled(chatIds.map(async (chatId) => {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  }));
  const failed = results.filter((result) => result.status === "rejected");
  return {
    ok: failed.length === 0,
    sent: chatIds.length - failed.length,
    failed: failed.length,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceKey) {
      return json({
        ok: false,
        error: "Notification service is not configured",
      }, 503);
    }
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: userData, error: userError } = await db.auth.getUser(token);
    const userId = text(userData?.user?.id, 100);
    if (userError || !userId) {
      return json(
        { ok: false, error: "Sign in to send booking notifications" },
        401,
      );
    }
    const { data: account, error: accountError } = await db
      .from("accounts")
      .select("role,status")
      .eq("id", userId)
      .maybeSingle();
    if (accountError || account?.status !== "active") {
      return json({ ok: false, error: "Active account required" }, 403);
    }

    const body = await req.json() as Record<string, unknown>;
    const bookingRef = text(body.bookingRef, 100);
    const event = text(body.event || "new_booking", 50).toLowerCase();
    if (!bookingRef || !ALLOWED_EVENTS.has(event)) {
      return json(
        { ok: false, error: "Booking reference or event is invalid" },
        400,
      );
    }

    const { data: primary, error: bookingError } = await db
      .from("bookings")
      .select(
        "ref,booking_group_ref,full_name,contact_number,court_name,date,start_time,end_time,total,downpayment,payment_method,payment_status,status,gcash_ref,host_user_id,created_by_user_id",
      )
      .eq("ref", bookingRef)
      .maybeSingle();
    if (bookingError || !primary) {
      return json({ ok: false, error: "Booking was not found" }, 404);
    }

    const role = text(account.role, 30).toLowerCase();
    const privileged = ["owner", "court_owner", "staff"].includes(role);
    const owningHost = role === "host" &&
      (primary.host_user_id === userId ||
        primary.created_by_user_id === userId);
    if (!privileged && !owningHost) {
      return json(
        { ok: false, error: "You cannot notify for this booking" },
        403,
      );
    }

    let rows = [primary] as Record<string, unknown>[];
    if (primary.booking_group_ref) {
      const { data: groupRows, error: groupError } = await db
        .from("bookings")
        .select(
          "ref,booking_group_ref,full_name,contact_number,court_name,date,start_time,end_time,total,downpayment,payment_method,payment_status,status,gcash_ref,host_user_id,created_by_user_id",
        )
        .eq("booking_group_ref", primary.booking_group_ref)
        .order("created_at", { ascending: true });
      if (groupError) {
        return json(
          { ok: false, error: "Booking group could not be loaded" },
          500,
        );
      }
      rows = groupRows || rows;
      if (
        role === "host" &&
        rows.some((row) =>
          row.host_user_id !== userId && row.created_by_user_id !== userId
        )
      ) {
        return json({
          ok: false,
          error: "You cannot notify for this booking group",
        }, 403);
      }
    }

    if (!eventMatchesCanonicalState(event, rows, privileged)) {
      return json({
        ok: false,
        error: "This notification does not match the saved booking state",
      }, 409);
    }

    const subjectId = text(primary.booking_group_ref, 100) ||
      text(primary.ref, 100);
    const eventKey = `telegram:${event}:${subjectId}`;
    const { error: claimError } = await db.from("notification_event_claims")
      .insert({
        event_key: eventKey,
        event_type: event,
        subject_type: primary.booking_group_ref ? "booking_group" : "booking",
        subject_id: subjectId,
      });
    if (claimError) {
      if (String(claimError.code || "") === "23505") {
        return json({
          ok: true,
          skipped: true,
          reason: "Notification already sent",
        });
      }
      return json(
        { ok: false, error: "Notification could not be claimed" },
        500,
      );
    }

    const delivery = await sendTelegram(bookingMessage(rows, event));
    if (!delivery.ok && Number(delivery.sent || 0) === 0) {
      await db.from("notification_event_claims").delete().eq(
        "event_key",
        eventKey,
      );
    }
    return json({ ok: true, delivery });
  } catch (error) {
    console.error("send-telegram-notification failed", error);
    return json({ ok: false, error: "Notification could not be sent" }, 500);
  }
});

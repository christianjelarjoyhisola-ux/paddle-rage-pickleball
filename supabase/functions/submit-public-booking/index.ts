import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const PUBLIC_COURT_OPENING_DATE = "2026-09-19";

function manilaToday(): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function minimumBookingDate(): string {
  const today = manilaToday();
  return today > PUBLIC_COURT_OPENING_DATE
    ? today
    : PUBLIC_COURT_OPENING_DATE;
}

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

function newBookingMessage(rows: Record<string, unknown>[]): string {
  const primary = rows[0] || {};
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const courts = [
    ...new Set(rows.map((row) => text(row.court_name, 150)).filter(Boolean)),
  ]
    .join(", ");
  const displayRef = text(primary.booking_group_ref, 100) ||
    text(primary.ref, 100);
  const date = new Date(`${text(primary.date, 10)}T00:00:00+08:00`);
  const dateLabel = Number.isNaN(date.getTime())
    ? text(primary.date, 10)
    : date.toLocaleDateString("en-PH", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "Asia/Manila",
    });
  const adminUrl = Deno.env.get("APP_ADMIN_URL") ||
    "https://paddleragecdo.ph/admin.html";
  return (
    `<b>NEW BOOKING</b>\n------------------\n` +
    `<b>${esc(primary.full_name)}</b>\n${
      esc(primary.contact_number || "")
    }\n\n` +
    `<b>${esc(courts || primary.court_name)}</b>\n${esc(dateLabel)}\n` +
    `${esc(primary.start_time)} - ${esc(primary.end_time)}` +
    (rows.length > 1 ? ` · ${rows.length} reservations` : "") +
    `\n\nPayment: <b>${
      esc(text(primary.payment_method, 30).toUpperCase())
    }</b>` +
    `\nTotal: ${fmtPHP(total)}` +
    `\nBooking ref: <code>${esc(displayRef)}</code>\n` +
    `------------------\n<a href="${adminUrl}">Open the Paddle Rage dashboard.</a>`
  );
}

async function notifyNewBooking(
  db: any,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const primary = rows[0] || {};
  const subjectId = text(primary.booking_group_ref, 100) ||
    text(primary.ref, 100);
  if (!subjectId) {
    return { ok: false, skipped: true, reason: "Missing booking reference" };
  }

  const botToken = text(Deno.env.get("TELEGRAM_BOT_TOKEN"), 500);
  const chatIds = text(Deno.env.get("TELEGRAM_CHAT_ID"), 1000)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!botToken || !chatIds.length) {
    return { ok: true, skipped: true, reason: "Telegram not configured" };
  }

  const eventKey = `telegram:new_booking:${subjectId}`;
  const { error: claimError } = await db.from("notification_event_claims")
    .insert({
      event_key: eventKey,
      event_type: "new_booking",
      subject_type: primary.booking_group_ref ? "booking_group" : "booking",
      subject_id: subjectId,
    });
  if (claimError) {
    if (String(claimError.code || "") === "23505") {
      return { ok: true, skipped: true, reason: "Notification already sent" };
    }
    return { ok: false, skipped: true, reason: "Notification claim failed" };
  }

  const message = newBookingMessage(rows);
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
  if (failed.length === chatIds.length) {
    await db.from("notification_event_claims").delete().eq(
      "event_key",
      eventKey,
    );
  }
  return {
    ok: failed.length === 0,
    sent: chatIds.length - failed.length,
    failed: failed.length,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function publicBookingRow(value: unknown): Record<string, unknown> {
  const row = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const total = Number(row.total);
  return {
    ref: text(row.ref, 100),
    booking_group_ref: text(row.booking_group_ref, 100) || null,
    full_name: text(row.full_name, 150),
    contact_number: text(row.contact_number, 40) || null,
    email: text(row.email, 254) || null,
    court_id: text(row.court_id, 100),
    court_name: text(row.court_name, 150),
    date: text(row.date, 10),
    slots: Array.isArray(row.slots) ? row.slots.slice(0, 24) : [],
    start_time: text(row.start_time, 30),
    end_time: text(row.end_time, 30),
    duration: Number(row.duration),
    rate: Number(row.rate),
    total,
    payment_method: text(row.payment_method || "cash", 30).toLowerCase(),
    received_account: text(row.received_account || "cash", 30).toLowerCase(),
    payment_flow: text(row.payment_flow, 30) || null,
    gcash_ref: text(row.gcash_ref, 100) || null,
    // Public court bookings always require full payment. Host reservation
    // payments use the authenticated account path instead of this endpoint.
    downpayment: total,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 128 * 1024) {
    return json({ ok: false, error: "Request is too large" }, 413);
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const bookings = Array.isArray(body.bookings)
      ? body.bookings.map(publicBookingRow)
      : [];
    const accessToken = text(body.accessToken, 256);

    if (bookings.length < 1 || bookings.length > 8) {
      return json({
        ok: false,
        error: "Choose between one and eight booking items.",
      }, 400);
    }
    if (!/^[0-9a-f]{64}$/i.test(accessToken)) {
      return json({
        ok: false,
        error: "Secure booking access token is invalid.",
      }, 400);
    }
    const minimumDate = minimumBookingDate();
    if (bookings.some((booking) => {
      const date = text(booking.date, 10);
      return !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < minimumDate;
    })) {
      return json({
        ok: false,
        error: `Advance booking is available from ${minimumDate}.`,
      }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceKey) {
      return json(
        { ok: false, error: "Booking service is not configured." },
        503,
      );
    }

    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await db.rpc("submit_public_booking_holds", {
      p_bookings: bookings,
      p_access_token_hash: await sha256Hex(accessToken.toLowerCase()),
    });
    if (error) {
      console.error("submit_public_booking_holds failed", error.message);
      return json({ ok: false, error: error.message }, 409);
    }

    const refs = (Array.isArray(data) ? data : [])
      .map((row) => text(row?.booking_ref, 100))
      .filter(Boolean);
    if (refs.length !== bookings.length) {
      return json({ ok: false, error: "Booking holds were not created." }, 500);
    }

    const { data: savedRows, error: savedRowsError } = await db
      .from("bookings")
      .select(
        "ref,booking_group_ref,full_name,contact_number,court_name,date,start_time,end_time,total,payment_method",
      )
      .in("ref", refs)
      .order("created_at", { ascending: true });
    // Review-only Telegram mode: a newly created hold is not itself an
    // actionable review item. Receipt verification sends the canonical alert
    // later if the payment is routed to manual review.
    const notification = {
      ok: true,
      skipped: true,
      reason: "Telegram alerts are limited to payment review",
    };

    return json({ ok: true, refs, notification });
  } catch (error) {
    console.error("submit-public-booking failed", error);
    return json({ ok: false, error: "Booking could not be submitted." }, 500);
  }
});

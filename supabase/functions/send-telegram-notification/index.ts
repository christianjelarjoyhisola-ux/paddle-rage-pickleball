import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendTelegramHtml } from "../_shared/telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Telegram is intentionally reserved for work that needs an admin decision.
// Routine booking lifecycle events continue through the dashboard/email flows.
const ALLOWED_EVENTS = new Set(["payment_review_needed"]);

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
  return `₱${
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
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Manila",
  });
}

function fmtDateTime(value: unknown): string {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Manila",
  });
  const timePart = date.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  });
  return `${datePart} · ${timePart}`;
}

function timeMinutes(value: unknown): number | null {
  const match = String(value || "").trim().match(
    /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i,
  );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = String(match[3] || "").toUpperCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23)) return null;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (meridiem === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

function courtHours(row: Record<string, unknown>): number {
  if (Array.isArray(row.slots) && row.slots.length) return row.slots.length;
  const start = timeMinutes(row.start_time);
  const end = timeMinutes(row.end_time);
  if (start == null || end == null) return 0;
  return Math.max(0, (end - start) / 60);
}

function formatHours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
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
): boolean {
  if (event !== "payment_review_needed" || !rows.length) return false;
  return rows.every((row) => {
    const method = text(row.payment_method, 30).toLowerCase();
    const receipt = text(row.receipt_status, 30).toLowerCase();
    const status = text(row.status, 30).toLowerCase();
    const payment = text(row.payment_status, 30).toLowerCase();
    return method !== "cash" &&
      receipt !== "manual_review" &&
      status === "pending" &&
      payment === "for_verification";
  });
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
  const displayRef = text(primary.booking_group_ref, 100) ||
    text(primary.ref, 100);
  const method = text(primary.payment_method, 30).toUpperCase();
  const courts = [...rows].sort((a, b) =>
    text(a.court_name, 150).localeCompare(text(b.court_name, 150), "en", {
      numeric: true,
    })
  );
  const totalHours = courts.reduce((sum, row) => sum + courtHours(row), 0);
  const dates = [...new Set(courts.map((row) => text(row.date, 10)))]
    .filter(Boolean);
  const sharedDate = dates.length === 1 ? dates[0] : "";
  const courtLines = courts.map((row, index) => {
    const name = text(row.court_name, 150) || `Court ${index + 1}`;
    const datePrefix = sharedDate ? "" : `${fmtDate(row.date)} · `;
    return `🎾 ${esc(name)} · ${esc(datePrefix)}${
      esc(row.start_time)
    }–${esc(row.end_time)} · ${fmtPHP(row.total)}`;
  }).join("\n");
  const countLabel = `${courts.length} ${
    courts.length === 1 ? "court" : "courts"
  } · ${formatHours(totalHours)} ${
    courts.length === 1 ? "hours" : "court-hours"
  }`;

  return (
    `⚠️ <b>${esc(eventLabel(event))}</b>\n` +
    `👤 Player: ${esc(primary.full_name)}\n` +
    `📋 Ref: <code>${esc(displayRef)}</code>\n` +
    `💳 Payment: ${esc(method)}\n` +
    `🕒 Submitted: ${esc(fmtDateTime(primary.created_at))}\n` +
    `🚩 Issue: REVIEW_REQUIRED\n\n` +
    `🏟️ <b>COURT SCHEDULE</b>\n` +
    `${countLabel}\n` +
    (sharedDate ? `📅 ${esc(fmtDate(sharedDate))}\n` : "") +
    `${courtLines}\n` +
    `💰 <b>TOTAL PAYMENT: ${fmtPHP(total)}</b>\n\n` +
    `🔗 <a href="${adminUrl()}">Open the Paddle Rage dashboard</a>`
  );
}

async function sendTelegram(message: string): Promise<Record<string, unknown>> {
  return await sendTelegramHtml(message);
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
        "ref,booking_group_ref,full_name,contact_number,court_name,date,slots,start_time,end_time,total,downpayment,payment_method,payment_status,receipt_status,status,gcash_ref,host_user_id,created_by_user_id,created_at",
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
          "ref,booking_group_ref,full_name,contact_number,court_name,date,slots,start_time,end_time,total,downpayment,payment_method,payment_status,receipt_status,status,gcash_ref,host_user_id,created_by_user_id,created_at",
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

    if (!eventMatchesCanonicalState(event, rows)) {
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

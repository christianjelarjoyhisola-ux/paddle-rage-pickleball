import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  emailCorsHeaders,
  isAllowedEmailOrigin,
  jsonResponse,
  requireAdminEmailRequest,
} from "../_shared/email-request.ts";
import { confirmedBookingPaidAmount } from "../_shared/booking-email-payment.ts";
import { isEmailAddress, sendMailerooEmail } from "../_shared/maileroo.ts";
import { renderBookingCancellationEmail } from "../_shared/paddle-rage-email.ts";

type BookingRow = {
  ref: string;
  booking_group_ref: string | null;
  full_name: string;
  email: string | null;
  court_name: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  total: number | null;
  downpayment: number | null;
  payment_status: string;
  status: string;
};

const BOOKING_COLUMNS = [
  "ref",
  "booking_group_ref",
  "full_name",
  "email",
  "court_name",
  "date",
  "start_time",
  "end_time",
  "total",
  "downpayment",
  "payment_status",
  "status",
].join(",");

function validBookingRef(value: unknown): string {
  const ref = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(ref)) {
    throw new Error("Invalid booking reference");
  }
  return ref;
}

async function loadRows(db: any, bookingRef: string): Promise<BookingRow[]> {
  const { data: direct, error: directError } = await db.from("bookings")
    .select(BOOKING_COLUMNS).eq("ref", bookingRef).maybeSingle();
  if (directError) throw directError;
  if (!direct) return [];
  if (!direct.booking_group_ref) return [direct as BookingRow];
  const { data, error } = await db.from("bookings").select(BOOKING_COLUMNS)
    .eq("booking_group_ref", direct.booking_group_ref)
    .order("date", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) throw error;
  return (data || []) as BookingRow[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return isAllowedEmailOrigin(req)
      ? new Response(null, { status: 204, headers: emailCorsHeaders(req) })
      : new Response("Origin not allowed", { status: 403 });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { ok: false, error: "Method not allowed" }, 405);
  }
  if (!isAllowedEmailOrigin(req)) {
    return jsonResponse(req, { ok: false, error: "Origin not allowed" }, 403);
  }

  try {
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim();
    const serviceRoleKey = (Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Email service database access is not configured");
    }
    const db = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    await requireAdminEmailRequest(req, db);

    const body = await req.json().catch(() => null) as {
      bookingRef?: unknown;
      event?: unknown;
      reason?: unknown;
    } | null;
    const bookingRef = validBookingRef(body?.bookingRef);
    const event = String(body?.event || "").trim();
    if (!new Set(["booking_cancelled", "payment_rejected"]).has(event)) {
      throw new Error("Invalid booking email event");
    }
    const rows = await loadRows(db, bookingRef);
    if (!rows.length || rows.some((row) => row.status !== "cancelled")) {
      return jsonResponse(req, {
        ok: false,
        error: "Cancelled booking could not be verified",
      }, 409);
    }
    if (
      event === "payment_rejected" &&
      rows.some((row) => row.payment_status !== "rejected")
    ) {
      return jsonResponse(req, {
        ok: false,
        error: "Rejected payment could not be verified",
      }, 409);
    }

    const first = rows[0];
    const email = String(first.email || "").trim().toLowerCase();
    if (
      !isEmailAddress(email) ||
      rows.some((row) => String(row.email || "").trim().toLowerCase() !== email)
    ) {
      return jsonResponse(req, {
        ok: true,
        skipped: true,
        reason: "No customer email",
      });
    }
    const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
    const paid = rows.reduce((sum, row) =>
      sum + confirmedBookingPaidAmount({
        paymentStatus: row.payment_status,
        total: row.total,
        downpayment: row.downpayment,
      }), 0);
    const displayRef = first.booking_group_ref
      ? first.booking_group_ref.replace(/-G$/, "")
      : first.ref;
    const content = renderBookingCancellationEmail({
      bookingRef: displayRef,
      fullName: first.full_name || "Player",
      courtName: [
        ...new Set(rows.map((row) => row.court_name).filter(Boolean)),
      ].join(", ") || "Court",
      date: first.date,
      startTime: first.start_time || "",
      endTime: first.end_time || "",
      total,
      paid,
      reason: String(body?.reason || "").trim().slice(0, 1200),
      paymentRejected: event === "payment_rejected",
    });
    const sent = await sendMailerooEmail({
      to: email,
      toName: first.full_name || "Player",
      subject: `${
        event === "payment_rejected" ? "Payment rejected" : "Booking cancelled"
      }: ${displayRef} | Paddle Rage Pickleball`,
      html: content.html,
      plain: content.plain,
      tags: {
        message_type: event.replace(/_/g, "-"),
        booking_reference: displayRef,
      },
    });
    return jsonResponse(req, { ok: true, id: sent.id });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unable to send booking status email";
    const status = message === "Admin access required"
      ? 403
      : message.startsWith("Invalid ")
      ? 400
      : 500;
    return jsonResponse(req, { ok: false, error: message }, status);
  }
});

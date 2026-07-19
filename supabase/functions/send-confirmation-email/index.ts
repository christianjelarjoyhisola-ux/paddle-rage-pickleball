import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  emailCorsHeaders,
  isAdminEmailRequest,
  isAllowedEmailOrigin,
  jsonResponse,
} from "../_shared/email-request.ts";
import { confirmedBookingPaidAmount } from "../_shared/booking-email-payment.ts";
import { isEmailAddress, sendMailerooEmail } from "../_shared/maileroo.ts";
import {
  type ConfirmationPayload,
  renderConfirmationEmail,
} from "../_shared/paddle-rage-email.ts";

type BookingRow = {
  ref: string;
  booking_group_ref: string | null;
  full_name: string;
  email: string | null;
  court_name: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  duration: number | null;
  total: number | null;
  downpayment: number | null;
  payment_status: string;
  host_booking: boolean;
  balance_due_at: string | null;
  confirmation_email_id: string | null;
  confirmation_email_sent_at: string | null;
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
  "duration",
  "total",
  "downpayment",
  "payment_status",
  "host_booking",
  "balance_due_at",
  "confirmation_email_id",
  "confirmation_email_sent_at",
  "status",
].join(",");

function validBookingRef(value: unknown): string {
  const ref = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(ref)) {
    throw new Error("Invalid booking reference");
  }
  return ref;
}

async function loadBookingRows(
  db: any,
  bookingRef: string,
): Promise<BookingRow[]> {
  const { data: direct, error: directError } = await db.from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("ref", bookingRef)
    .maybeSingle();
  if (directError) throw directError;

  const groupRef = direct?.booking_group_ref || (!direct ? bookingRef : null);
  if (!groupRef) return direct ? [direct as BookingRow] : [];

  const { data: grouped, error: groupError } = await db.from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("booking_group_ref", groupRef)
    .order("date", { ascending: true })
    .order("start_time", { ascending: true });
  if (groupError) throw groupError;
  if (grouped?.length) return grouped as BookingRow[];
  return direct ? [direct as BookingRow] : [];
}

function verifiedPayload(
  rows: BookingRow[],
  requestedEmail: string,
): ConfirmationPayload {
  const first = rows[0];
  if (!first || rows.some((row) => row.status !== "confirmed")) {
    throw new Error("Booking could not be verified");
  }
  const recipient = String(first.email || "").trim().toLowerCase();
  if (
    !isEmailAddress(recipient) || recipient !== requestedEmail.toLowerCase()
  ) {
    throw new Error("Booking could not be verified");
  }
  if (
    rows.some((row) =>
      String(row.email || "").trim().toLowerCase() !== recipient
    )
  ) {
    throw new Error("Booking could not be verified");
  }
  const isHostBooking = rows.every((row) => row.host_booking === true);
  if (
    !isHostBooking &&
    rows.some((row) => String(row.payment_status || "") !== "paid")
  ) {
    throw new Error("Regular bookings require verified full payment");
  }

  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const paid = rows.reduce(
    (sum, row) =>
      sum + confirmedBookingPaidAmount({
        paymentStatus: row.payment_status,
        total: row.total,
        downpayment: row.downpayment,
      }),
    0,
  );
  const displayRef = first.booking_group_ref
    ? first.booking_group_ref.replace(/-G$/, "")
    : first.ref;
  const firstDeadline =
    rows.map((row) => row.balance_due_at).filter(Boolean).sort()[0] || null;

  return {
    bookingRef: displayRef,
    email: recipient,
    fullName: first.full_name || "Player",
    courtName: [...new Set(rows.map((row) => row.court_name).filter(Boolean))]
      .join(", "),
    date: first.date,
    startTime: first.start_time || "",
    endTime: first.end_time || "",
    duration: rows.reduce((sum, row) => sum + Number(row.duration || 0), 0),
    total,
    downpayment: paid,
    remainingBalance: Math.max(0, total - paid),
    hostBooking: isHostBooking,
    balanceDueAt: firstDeadline,
    bookingItems: rows.map((row) => ({
      courtName: row.court_name || "Court",
      date: row.date,
      startTime: row.start_time || "",
      endTime: row.end_time || "",
      duration: Number(row.duration || 0),
      total: Number(row.total || 0),
      downpayment: confirmedBookingPaidAmount({
        paymentStatus: row.payment_status,
        total: row.total,
        downpayment: row.downpayment,
      }),
    })),
  };
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

  let claimedRef = "";
  let claimToken = "";
  let db: any = null;
  try {
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").trim();
    const serviceRoleKey = (Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Email service database access is not configured");
    }
    db = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const body = await req.json().catch(() => null) as {
      bookingRef?: unknown;
      email?: unknown;
    } | null;
    const bookingRef = validBookingRef(body?.bookingRef);
    const requestedEmail = String(body?.email || "").trim().toLowerCase();
    if (!isEmailAddress(requestedEmail)) {
      return jsonResponse(
        req,
        { ok: false, error: "Valid email is required" },
        400,
      );
    }

    const rows = await loadBookingRows(db, bookingRef);
    if (!rows.length) {
      return jsonResponse(req, {
        ok: false,
        error: "Booking could not be verified",
      }, 404);
    }
    const payload = verifiedPayload(rows, requestedEmail);
    const isAdmin = await isAdminEmailRequest(req, db);

    // Every send uses a bounded database lease. Public checkout can claim only
    // the first confirmation; authenticated admins may explicitly resend, but
    // two clicks/runtimes can never deliver concurrently.
    claimedRef = rows[0].ref;
    const { data: claimRows, error: claimError } = await db.rpc(
      "claim_booking_confirmation_email",
      { p_booking_ref: claimedRef, p_force: isAdmin },
    );
    if (claimError) throw claimError;
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim?.claimed || !claim?.claim_token) {
      claimedRef = "";
      return jsonResponse(req, {
        ok: true,
        skipped: true,
        reason: claim?.reason === "already_sent"
          ? "Confirmation already sent"
          : "Confirmation already processing",
      });
    }
    claimToken = String(claim.claim_token);

    const content = renderConfirmationEmail(payload);
    const sent = await sendMailerooEmail({
      to: payload.email,
      toName: payload.fullName,
      subject:
        `Booking confirmed: ${payload.bookingRef} | Paddle Rage Pickleball`,
      html: content.html,
      plain: content.plain,
      tags: {
        message_type: "booking-confirmation",
        booking_reference: payload.bookingRef,
      },
    });

    const { data: tracked, error: trackingError } = await db.rpc(
      "finish_booking_confirmation_email",
      {
        p_booking_ref: claimedRef,
        p_claim_token: claimToken,
        p_success: true,
        p_provider_id: sent.id,
      },
    );
    if (trackingError || tracked !== true) {
      console.error(
        "Confirmation sent, but tracking update failed",
        trackingError?.message || "claim no longer matched",
      );
    }
    claimToken = "";

    return jsonResponse(req, { ok: true, id: sent.id });
  } catch (error) {
    if (db && claimedRef && claimToken) {
      try {
        await db.rpc("finish_booking_confirmation_email", {
          p_booking_ref: claimedRef,
          p_claim_token: claimToken,
          p_success: false,
          p_provider_id: null,
        });
      } catch {
        // Preserve the original provider error if cleanup cannot be recorded.
      }
    }
    const message = error instanceof Error
      ? error.message
      : "Unable to send confirmation email";
    const status = message === "Invalid booking reference"
      ? 400
      : message === "Booking could not be verified"
      ? 404
      : 500;
    return jsonResponse(req, { ok: false, error: message }, status);
  }
});

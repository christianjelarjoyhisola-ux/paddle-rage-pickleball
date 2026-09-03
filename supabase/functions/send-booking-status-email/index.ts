import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  emailCorsHeaders,
  isAllowedEmailOrigin,
  jsonResponse,
  requireAdminEmailRequest,
} from "../_shared/email-request.ts";
import { confirmedBookingPaidAmount } from "../_shared/booking-email-payment.ts";
import { isEmailAddress, sendMailerooEmail } from "../_shared/maileroo.ts";
import {
  renderBookingCancellationEmail,
  renderBookingPaymentTransferEmail,
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
  total: number | null;
  downpayment: number | null;
  payment_status: string;
  status: string;
  payment_transfer_id: string | null;
  payment_reassigned_from_ref: string | null;
  payment_reassigned_to_ref: string | null;
};

type BookingPaymentTransferRow = {
  id: string;
  source_booking_ref: string;
  source_booking_group_ref: string | null;
  target_booking_ref: string;
  target_booking_group_ref: string | null;
  source_booking_refs: string[];
  target_booking_refs: string[];
  amount: number;
  reason: string;
  created_at: string;
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
  "payment_transfer_id",
  "payment_reassigned_from_ref",
  "payment_reassigned_to_ref",
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

async function loadCanonicalPaymentRejectionReason(
  db: any,
  rows: BookingRow[],
): Promise<string> {
  const first = rows[0];
  let query = db.from("payment_review_decisions")
    .select("reason,created_at")
    .eq("decision", "reject");
  query = first.booking_group_ref
    ? query.eq("booking_group_ref", first.booking_group_ref)
    : query.eq("booking_ref", first.ref);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const reason = String(data?.reason || "").trim().slice(0, 1000);
  if (reason.length < 3) {
    throw new Error("Rejected payment reason could not be verified");
  }
  return reason;
}

async function loadCanonicalPaymentTransfer(
  db: any,
  rows: BookingRow[],
): Promise<BookingPaymentTransferRow> {
  const first = rows[0];
  let query = db.from("booking_payment_transfers").select(
    "id,source_booking_ref,source_booking_group_ref,target_booking_ref,target_booking_group_ref,source_booking_refs,target_booking_refs,amount,reason,created_at",
  );
  query = first.booking_group_ref
    ? query.eq("target_booking_group_ref", first.booking_group_ref)
    : query.eq("target_booking_ref", first.ref);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const transfer = data as BookingPaymentTransferRow | null;
  const reason = String(transfer?.reason || "").trim();
  const amount = Number(transfer?.amount || 0);
  if (!transfer || reason.length < 10 || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("Payment transfer audit could not be verified");
  }
  return { ...transfer, reason: reason.slice(0, 1000), amount };
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
    if (!new Set([
      "booking_cancelled",
      "payment_rejected",
      "payment_reassigned",
    ]).has(event)) {
      throw new Error("Invalid booking email event");
    }
    const rows = await loadRows(db, bookingRef);
    const paymentReassigned = event === "payment_reassigned";
    const validState = paymentReassigned
      ? rows.length > 0 && rows.every((row) =>
        row.status === "confirmed" &&
        new Set(["paid", "downpayment_paid"]).has(row.payment_status)
      )
      : rows.length > 0 && rows.every((row) => row.status === "cancelled");
    if (!validState) {
      return jsonResponse(req, {
        ok: false,
        error: paymentReassigned
          ? "Reassigned booking could not be verified"
          : "Cancelled booking could not be verified",
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
    const transfer = paymentReassigned
      ? await loadCanonicalPaymentTransfer(db, rows)
      : null;
    if (transfer) {
      const sourceRows = await loadRows(db, transfer.source_booking_ref);
      const targetEmail = String(first.email || "").trim().toLowerCase();
      const sourceRefs = new Set(transfer.source_booking_refs.map(String));
      const targetRefs = new Set(transfer.target_booking_refs.map(String));
      if (
        !sourceRows.length ||
        sourceRows.some((row) => row.status !== "cancelled") ||
        sourceRows.some((row) =>
          String(row.email || "").trim().toLowerCase() !== targetEmail
        ) ||
        sourceRows.length !== sourceRefs.size ||
        sourceRows.some((row) =>
          !sourceRefs.has(row.ref) ||
          row.payment_transfer_id !== transfer.id ||
          row.payment_reassigned_from_ref !== null ||
          row.payment_reassigned_to_ref !== transfer.target_booking_ref
        ) ||
        rows.length !== targetRefs.size ||
        rows.some((row) =>
          !targetRefs.has(row.ref) ||
          row.payment_transfer_id !== transfer.id ||
          row.payment_reassigned_from_ref !== transfer.source_booking_ref ||
          row.payment_reassigned_to_ref !== null
        )
      ) {
        throw new Error("Payment transfer audit could not be verified");
      }
    }
    const reason = event === "payment_rejected"
      ? await loadCanonicalPaymentRejectionReason(db, rows)
      : event === "payment_reassigned"
      ? transfer!.reason
      : String(body?.reason || "").trim().slice(0, 1200);
    const courtName = [
      ...new Set(rows.map((row) => row.court_name).filter(Boolean)),
    ].join(", ") || "Court";
    const content = transfer
      ? renderBookingPaymentTransferEmail({
        sourceBookingRef: transfer.source_booking_group_ref
          ? transfer.source_booking_group_ref.replace(/-G$/, "")
          : transfer.source_booking_ref,
        targetBookingRef: displayRef,
        fullName: first.full_name || "Player",
        courtName,
        date: first.date,
        startTime: first.start_time || "",
        endTime: first.end_time || "",
        amount: transfer.amount,
        reason,
      })
      : renderBookingCancellationEmail({
        bookingRef: displayRef,
        fullName: first.full_name || "Player",
        courtName,
        date: first.date,
        startTime: first.start_time || "",
        endTime: first.end_time || "",
        total,
        paid,
        reason,
        paymentRejected: event === "payment_rejected",
      });
    const sent = await sendMailerooEmail({
      to: email,
      toName: first.full_name || "Player",
      subject: `${
        event === "payment_rejected"
          ? "Payment rejected"
          : event === "payment_reassigned"
          ? "Payment moved to your new booking"
          : "Booking cancelled"
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
      : message === "Rejected payment reason could not be verified" ||
          message === "Payment transfer audit could not be verified"
      ? 409
      : message.startsWith("Invalid ")
      ? 400
      : 500;
    return jsonResponse(req, { ok: false, error: message }, status);
  }
});

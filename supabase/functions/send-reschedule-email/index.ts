import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  emailCorsHeaders,
  isAllowedEmailOrigin,
  jsonResponse,
  requireAdminEmailRequest,
} from "../_shared/email-request.ts";
import { isEmailAddress, sendMailerooEmail } from "../_shared/maileroo.ts";
import {
  renderGroupedRescheduleEmail,
  renderRescheduleEmail,
  type GroupedReschedulePayload,
  type ReschedulePayload,
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
  status: string;
};

function requiredText(value: unknown, field: string, maxLength = 200): string {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) throw new Error(`${field} is invalid`);
  return text;
}

function validBookingRef(value: unknown): string {
  const ref = requiredText(value, "bookingRef", 80);
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(ref)) {
    throw new Error("bookingRef is invalid");
  }
  return ref;
}

function validDate(value: unknown, field: string): string {
  const date = requiredText(value, field, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(new Date(`${date}T00:00:00+08:00`).getTime())
  ) {
    throw new Error(`${field} is invalid`);
  }
  return date;
}

function normalizeTime(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

class GroupedEmailError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const BOOKING_COLUMNS =
  "ref,booking_group_ref,full_name,email,court_name,date,start_time,end_time,duration,status";

function groupedScheduleItems(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new GroupedEmailError("Select between one and eight booking items.", 400);
  }
  const items = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new GroupedEmailError("Booking item is invalid.", 400);
    }
    const item = raw as Record<string, unknown>;
    const newDuration = Number(item.newDuration);
    if (!Number.isInteger(newDuration) || newDuration < 1 || newDuration > 24) {
      throw new GroupedEmailError("Booking item duration is invalid.", 400);
    }
    const oldDate = validDate(item.oldDate, "oldDate");
    const newDate = validDate(item.newDate, "newDate");
    if ([oldDate, newDate].some((date) =>
      new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date
    )) {
      throw new GroupedEmailError("Booking item date is invalid.", 400);
    }
    return {
      bookingRef: validBookingRef(item.bookingRef),
      oldDate,
      oldStartTime: requiredText(item.oldStartTime, "oldStartTime", 40),
      oldEndTime: requiredText(item.oldEndTime, "oldEndTime", 40),
      newDate,
      newStartTime: requiredText(item.newStartTime, "newStartTime", 40),
      newEndTime: requiredText(item.newEndTime, "newEndTime", 40),
      newDuration,
    };
  });
  if (new Set(items.map((item) => item.bookingRef)).size !== items.length) {
    throw new GroupedEmailError("Choose each booking item only once.", 400);
  }
  return items;
}

async function verifiedGroupedPayload(
  db: any,
  body: Record<string, unknown>,
): Promise<GroupedReschedulePayload> {
  const bookingRef = validBookingRef(body.bookingRef);
  const items = groupedScheduleItems(body.items);
  const { data, error } = await db.from("bookings").select(BOOKING_COLUMNS)
    .eq("ref", bookingRef).maybeSingle();
  if (error) throw error;
  const anchor = data as BookingRow | null;
  if (!anchor) throw new GroupedEmailError("Booking could not be verified", 404);

  const groupRef = String(anchor.booking_group_ref || "").trim();
  let family: BookingRow[] = [anchor];
  if (groupRef) {
    const result = await db.from("bookings").select(BOOKING_COLUMNS)
      .eq("booking_group_ref", groupRef).limit(9);
    if (result.error) throw result.error;
    family = result.data || [];
  }
  // A reused bank reference or a shared reference prefix is not a booking family.
  const email = String(anchor.email || "").trim().toLowerCase();
  if (family.length < 1 || family.length > 8 || !isEmailAddress(email)
    || !family.some((row) => row.ref === anchor.ref)
    || family.some((row) => String(row.email || "").trim().toLowerCase() !== email)) {
    throw new GroupedEmailError("Booking family could not be verified", 409);
  }
  const byRef = new Map(family.map((row) => [row.ref, row]));
  const canonicalItems = items.map((item) => {
    const booking = byRef.get(item.bookingRef);
    if (!booking || ["cancelled", "forfeited"].includes(booking.status)) {
      throw new GroupedEmailError("Booking item could not be verified", 404);
    }
    if (booking.date !== item.newDate
      || normalizeTime(booking.start_time) !== normalizeTime(item.newStartTime)
      || normalizeTime(booking.end_time) !== normalizeTime(item.newEndTime)
      || Number(booking.duration) !== item.newDuration) {
      throw new GroupedEmailError("New schedule does not match the saved booking", 409);
    }
    return {
      ...item,
      courtName: booking.court_name || "Court",
      newDate: booking.date,
      newStartTime: booking.start_time || "",
      newEndTime: booking.end_time || "",
      newDuration: Number(booking.duration),
    };
  });
  return {
    bookingRef: groupRef ? groupRef.replace(/-G$/i, "") : anchor.ref,
    email,
    fullName: anchor.full_name || "Player",
    items: canonicalItems,
    note: String(body.note || "").trim().slice(0, 1200),
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

    const body = await req.json().catch(() => null) as
      | (Partial<ReschedulePayload> & Record<string, unknown>)
      | null;
    if (body && Object.prototype.hasOwnProperty.call(body, "items")) {
      const payload = await verifiedGroupedPayload(db, body);
      const content = renderGroupedRescheduleEmail(payload);
      const sent = await sendMailerooEmail({
        to: payload.email,
        toName: payload.fullName,
        subject: `Booking rescheduled: ${payload.bookingRef} | Paddle Rage Pickleball`,
        html: content.html,
        plain: content.plain,
        tags: {
          message_type: "booking-reschedule",
          booking_reference: payload.bookingRef,
        },
      });
      return jsonResponse(req, { ok: true, id: sent.id });
    }
    const bookingRef = validBookingRef(body?.bookingRef);
    const email = String(body?.email || "").trim().toLowerCase();
    if (!isEmailAddress(email)) throw new Error("email is invalid");

    const payload: ReschedulePayload = {
      bookingRef,
      email,
      fullName: requiredText(body?.fullName, "fullName", 160),
      courtName: requiredText(body?.courtName, "courtName", 160),
      oldDate: validDate(body?.oldDate, "oldDate"),
      oldStartTime: requiredText(body?.oldStartTime, "oldStartTime", 40),
      oldEndTime: requiredText(body?.oldEndTime, "oldEndTime", 40),
      newDate: validDate(body?.newDate, "newDate"),
      newStartTime: requiredText(body?.newStartTime, "newStartTime", 40),
      newEndTime: requiredText(body?.newEndTime, "newEndTime", 40),
      newDuration: Number(body?.newDuration || 0),
      note: String(body?.note || "").trim().slice(0, 1200),
    };
    if (
      !Number.isFinite(payload.newDuration) || payload.newDuration <= 0 ||
      payload.newDuration > 24
    ) {
      throw new Error("newDuration is invalid");
    }

    const { data, error } = await db.from("bookings")
      .select(
        "ref,booking_group_ref,full_name,email,court_name,date,start_time,end_time,duration,status",
      )
      .eq("ref", bookingRef)
      .maybeSingle();
    if (error) throw error;
    const booking = data as BookingRow | null;
    if (!booking || ["cancelled", "forfeited"].includes(booking.status)) {
      return jsonResponse(req, {
        ok: false,
        error: "Booking could not be verified",
      }, 404);
    }
    if (String(booking.email || "").trim().toLowerCase() !== payload.email) {
      return jsonResponse(req, {
        ok: false,
        error: "Booking could not be verified",
      }, 404);
    }
    // The administrative flow saves the replacement schedule before sending.
    // Confirm it matches the database so an intercepted/stale request cannot
    // send plausible-looking but incorrect booking information.
    if (
      booking.date !== payload.newDate ||
      normalizeTime(booking.start_time) !==
        normalizeTime(payload.newStartTime) ||
      normalizeTime(booking.end_time) !== normalizeTime(payload.newEndTime)
    ) {
      return jsonResponse(req, {
        ok: false,
        error: "New schedule does not match the saved booking",
      }, 409);
    }

    payload.fullName = booking.full_name || payload.fullName;
    payload.courtName = booking.court_name || payload.courtName;
    payload.newDuration = Number(booking.duration || payload.newDuration);

    const content = renderRescheduleEmail(payload);
    const sent = await sendMailerooEmail({
      to: payload.email,
      toName: payload.fullName,
      subject:
        `Booking rescheduled: ${payload.bookingRef} | Paddle Rage Pickleball`,
      html: content.html,
      plain: content.plain,
      tags: {
        message_type: "booking-reschedule",
        booking_reference: payload.bookingRef,
      },
    });
    return jsonResponse(req, { ok: true, id: sent.id });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Unable to send reschedule email";
    const status = error instanceof GroupedEmailError
      ? error.status
      : message === "Admin access required"
      ? 403
      : / is invalid$/.test(message)
      ? 400
      : 500;
    return jsonResponse(req, { ok: false, error: message }, status);
  }
});

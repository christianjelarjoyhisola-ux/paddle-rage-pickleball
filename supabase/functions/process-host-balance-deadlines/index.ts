import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  claimBalanceNotification,
  finishBalanceNotification,
} from "../_shared/balance-notification-lease.ts";
import { sendMailerooEmail } from "../_shared/maileroo.ts";
import { renderBalanceNoticeEmail } from "../_shared/paddle-rage-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };
const DAY_MS = 86_400_000;
const NOTICE_LEASE_SECONDS = 300;
const BALANCE_EVENT_TYPES = new Set([
  "reminder_3d",
  "reminder_2d",
  "reminder_1d",
  "forfeited",
  "manual",
]);

type BookingRow = {
  ref: string;
  booking_group_ref: string | null;
  full_name: string;
  email: string;
  host_name: string | null;
  host_email: string | null;
  court_name: string;
  date: string;
  start_time: string;
  end_time: string;
  total: number;
  downpayment: number;
  balance_due_at: string;
  forfeited_at: string | null;
  status: string;
  payment_status: string;
};

type PendingBalancePayment = {
  booking_key: string | null;
  booking_ref: string | null;
  booking_group_ref: string | null;
  booking_refs: string[] | null;
};

function groupRows(rows: BookingRow[]): BookingRow[][] {
  const groups = new Map<string, BookingRow[]>();
  for (const row of rows) {
    const key = row.booking_group_ref || row.ref;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups.values()];
}

async function loadPendingBalancePayments(db: any): Promise<PendingBalancePayment[]> {
  const payments: PendingBalancePayment[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 1_000_000; offset += pageSize) {
    const { data, error } = await db.from("host_booking_balance_payments")
      .select("booking_key,booking_ref,booking_group_ref,booking_refs")
      .eq("status", "pending_review")
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = (data || []) as PendingBalancePayment[];
    payments.push(...rows);
    if (rows.length < pageSize) return payments;
  }
  throw new Error("Pending balance queue is too large to process safely");
}

function groupHasPendingBalance(
  rows: BookingRow[],
  payments: PendingBalancePayment[],
): boolean {
  const refs = new Set<string>();
  for (const row of rows) {
    if (row.ref) refs.add(String(row.ref));
    if (row.booking_group_ref) refs.add(String(row.booking_group_ref));
  }
  return payments.some((payment) => [
    payment.booking_key,
    payment.booking_ref,
    payment.booking_group_ref,
    ...(Array.isArray(payment.booking_refs) ? payment.booking_refs : []),
  ].some((ref) => ref && refs.has(String(ref))));
}

function summary(rows: BookingRow[]) {
  const first = rows[0];
  const key = first.booking_group_ref || first.ref;
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const paid = rows.reduce((sum, row) => sum + Number(row.downpayment || 0), 0);
  const deadline =
    rows.map((row) => row.balance_due_at).filter(Boolean).sort()[0];
  const courts = [...new Set(rows.map((row) => row.court_name).filter(Boolean))]
    .join(", ");
  const schedules = rows.map((row) => ({
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
  })).filter((value, index, all) =>
    all.findIndex((candidate) =>
      candidate.date === value.date &&
      candidate.startTime === value.startTime &&
      candidate.endTime === value.endTime
    ) === index
  );
  return {
    key,
    ref: first.ref,
    name: first.host_name || first.full_name || "Host",
    email: first.host_email || first.email,
    total,
    paid,
    balance: Math.max(0, total - paid),
    deadline,
    courts,
    schedules,
  };
}

async function assertAdmin(req: Request, db: any) {
  const token = (req.headers.get("authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!token) throw new Error("Admin sign-in required");
  const { data: userData } = await db.auth.getUser(token);
  const userId = userData.user?.id;
  if (!userId) throw new Error("Admin sign-in required");
  const { data: accountData } = await db.from("accounts").select("role,status")
    .eq("id", userId).single();
  const account = accountData as { role?: string; status?: string } | null;
  if (
    !account || account.status !== "active" ||
    !["owner", "court_owner", "staff"].includes(String(account.role || ""))
  ) {
    throw new Error("Admin access required");
  }
}

async function assertCronRequest(req: Request, db: any) {
  const token = (req.headers.get("x-cron-secret") || "").trim();
  if (token.length < 32 || token.length > 256) {
    throw new Error("Cron authentication required");
  }
  const { data, error } = await db.rpc("verify_balance_cron_secret", {
    p_token: token,
  });
  if (error || data !== true) {
    throw new Error("Cron authentication required");
  }
}

async function sendNotice(
  db: any,
  rows: BookingRow[],
  eventType: string,
  force = false,
) {
  const info = summary(rows);
  if (!info.email || !info.deadline || info.balance <= 0) {
    return { skipped: true, reason: "No recipient or balance" };
  }

  if (!BALANCE_EVENT_TYPES.has(eventType)) {
    throw new Error("Invalid balance notification event");
  }
  const claim = await claimBalanceNotification(db, {
    bookingKey: info.key,
    bookingRef: info.ref,
    eventType,
    recipientEmail: info.email,
    force,
    leaseSeconds: NOTICE_LEASE_SECONDS,
  });
  if (!claim.acquired) {
    const reason = claim.reason === "already_sent"
      ? "Already sent"
      : claim.reason === "lease_active"
      ? "Already processing"
      : claim.reason === "balance_pending_review"
      ? "Balance receipt pending owner review"
      : claim.reason === "balance_already_paid"
      ? "Balance is already paid"
      : claim.reason === "booking_not_payable"
      ? "Booking is no longer eligible for a balance reminder"
      : "Notification claim was not acquired";
    return {
      skipped: true,
      reason,
      reasonCode: claim.reason,
      leaseExpiresAt: claim.leaseExpiresAt,
    };
  }

  const content = renderBalanceNoticeEmail({
    eventType: eventType as
      | "reminder_3d"
      | "reminder_2d"
      | "reminder_1d"
      | "forfeited"
      | "manual",
    bookingRef: info.key,
    fullName: info.name,
    courtName: info.courts,
    schedules: info.schedules,
    paid: info.paid,
    remainingBalance: info.balance,
    deadline: info.deadline,
  });
  let sent: { id: string };
  try {
    sent = await sendMailerooEmail({
      to: info.email,
      toName: info.name,
      subject: `${content.subject} | Paddle Rage Pickleball`,
      html: content.html,
      plain: content.plain,
      tags: {
        message_type: `balance-${eventType}`,
        booking_reference: info.key,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let failureRecorded = false;
    try {
      failureRecorded = await finishBalanceNotification(db, {
        id: claim.id,
        claimToken: claim.claimToken,
        outcome: "failed",
        errorMessage: message,
      });
    } catch (finishError) {
      console.error(
        "Unable to record failed balance notification attempt",
        finishError instanceof Error
          ? finishError.message
          : String(finishError),
      );
    }
    return {
      sent: false,
      failed: true,
      retryable: true,
      error: message,
      failureRecorded,
      eventType,
      bookingKey: info.key,
      attemptCount: claim.attemptCount,
    };
  }

  // Provider acceptance and database completion cannot share one transaction.
  // Never mark an accepted message failed if completion has a transient error:
  // doing so would make a later retry more likely to duplicate the email.
  let trackingFinalized = false;
  try {
    trackingFinalized = await finishBalanceNotification(db, {
      id: claim.id,
      claimToken: claim.claimToken,
      outcome: "sent",
      providerMessageId: sent.id,
    });
  } catch (finishError) {
    console.error(
      "Balance notification was accepted but could not be finalized",
      finishError instanceof Error ? finishError.message : String(finishError),
    );
  }
  if (!trackingFinalized) {
    console.error(
      "Balance notification completion lost its delivery lease",
      {
        id: claim.id,
        bookingKey: info.key,
        eventType,
        providerMessageId: sent.id,
      },
    );
  }
  return {
    sent: true,
    eventType,
    bookingKey: info.key,
    providerMessageId: sent.id,
    attemptCount: claim.attemptCount,
    trackingFinalized,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }
  try {
    const url = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !serviceKey) {
      throw new Error("Balance processor environment is incomplete");
    }
    const db = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
    const body = await req.json().catch(() => ({}));

    if (body.action === "manual") {
      await assertAdmin(req, db);
      const ref = String(body.bookingRef || "");
      const { data: seed } = await db.from("bookings").select(
        "booking_group_ref",
      ).eq("ref", ref).single();
      const key = seed?.booking_group_ref || ref;
      const { data: manualRows, error } = await db.from("bookings").select("*")
        .or(`ref.eq.${key},booking_group_ref.eq.${key}`);
      if (error || !manualRows?.length) {
        throw error || new Error("Booking not found");
      }
      const pendingPayments = await loadPendingBalancePayments(db);
      if (groupHasPendingBalance(manualRows as BookingRow[], pendingPayments)) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "A balance receipt is already awaiting owner review. Do not send another payment reminder.",
          }),
          { status: 409, headers: JSON_HEADERS },
        );
      }
      const eventType = manualRows.some((row: BookingRow) =>
          row.status === "forfeited"
        )
        ? "forfeited"
        : String(body.eventType || "reminder_1d");
      const result = await sendNotice(
        db,
        manualRows as BookingRow[],
        eventType,
        true,
      );
      if (result.failed) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: result.error || "Balance notice delivery failed",
            result,
          }),
          { status: 502, headers: JSON_HEADERS },
        );
      }
      if (!result.sent) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: result.reason || "Balance notice was not sent",
            result,
          }),
          { status: 409, headers: JSON_HEADERS },
        );
      }
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: JSON_HEADERS,
      });
    }

    if (body.action === "process" || body.source === "admin") {
      await assertAdmin(req, db);
    } else {
      await assertCronRequest(req, db);
    }

    const { data, error } = await db.from("bookings").select("*")
      .eq("host_booking", true).eq("status", "confirmed").eq(
        "payment_status",
        "downpayment_paid",
      )
      .not("balance_due_at", "is", null);
    if (error) throw error;
    const pendingPayments = await loadPendingBalancePayments(db);

    const results = [];
    const now = Date.now();
    for (const rows of groupRows((data || []) as BookingRow[])) {
      if (groupHasPendingBalance(rows, pendingPayments)) {
        results.push({
          skipped: true,
          reason: "Balance receipt pending owner review",
          bookingKey: summary(rows).key,
        });
        continue;
      }
      const info = summary(rows);
      const remaining = new Date(info.deadline).getTime() - now;
      if (remaining <= 0) {
        const { data: forfeiture, error: forfeitError } = await db.rpc(
          "forfeit_overdue_host_booking",
          { p_booking_key: info.key },
        );
        if (forfeitError) throw forfeitError;
        if (Number(forfeiture?.changed || 0) > 0) {
          results.push(await sendNotice(db, rows, "forfeited"));
        }
      } else if (remaining <= DAY_MS) {
        results.push(await sendNotice(db, rows, "reminder_1d"));
      } else if (remaining <= 2 * DAY_MS) {
        results.push(await sendNotice(db, rows, "reminder_2d"));
      } else if (remaining <= 3 * DAY_MS) {
        results.push(await sendNotice(db, rows, "reminder_3d"));
      }
    }

    // A status change must not suppress a forfeiture email retry. Failed logs
    // are retried on the next cron pass; sent logs remain idempotent.
    const { data: forfeitedData, error: forfeitedError } = await db.from(
      "bookings",
    ).select("*")
      .eq("host_booking", true).eq("status", "forfeited").eq(
        "payment_status",
        "deposit_retained",
      )
      .not("balance_due_at", "is", null);
    if (forfeitedError) throw forfeitedError;
    for (const rows of groupRows((forfeitedData || []) as BookingRow[])) {
      results.push(await sendNotice(db, rows, "forfeited"));
    }
    return new Response(
      JSON.stringify({
        ok: true,
        processed: results.length,
        sent: results.filter((result) => result.sent).length,
        failed: results.filter((result) => result.failed).length,
        skipped: results.filter((result) => result.skipped).length,
        results,
      }),
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Cron authentication required"
      ? 401
      : /Admin (?:sign-in|access) required/.test(message)
      ? 403
      : message === "Invalid balance notification event"
      ? 400
      : 500;
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status,
      headers: JSON_HEADERS,
    });
  }
});

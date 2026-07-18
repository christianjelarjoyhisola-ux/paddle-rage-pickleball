import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  claimBalanceNotification,
  finishBalanceNotification,
} from "../_shared/balance-notification-lease.ts";
import { sendMailerooEmail } from "../_shared/maileroo.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };
const LOGO_URL = Deno.env.get("PUBLIC_LOGO_URL") ||
  "https://paddleragecdo.ph/paddleragelogo.jpg";
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

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

function php(value: number): string {
  return `&#8369;${
    Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

function phDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00+08:00`));
}

function groupRows(rows: BookingRow[]): BookingRow[][] {
  const groups = new Map<string, BookingRow[]>();
  for (const row of rows) {
    const key = row.booking_group_ref || row.ref;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups.values()];
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
  const schedules = rows.map((row) =>
    `${dateLabel(row.date)} &middot; ${esc(row.start_time)}&ndash;${
      esc(row.end_time)
    }`
  ).filter((v, i, all) => all.indexOf(v) === i).join("<br>");
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

function noticeCopy(eventType: string, balance: number, deadline: string) {
  if (eventType === "forfeited") {
    return {
      subject: "Reservation forfeited - slot released",
      heading: "RESERVATION FORFEITED",
      accent: "#c83d26",
      message:
        `Your reservation was forfeited because the remaining balance of <strong>${
          php(balance)
        }</strong> was not paid by the deadline. The court slot has been released and the payment already made remains non-refundable.`,
    };
  }
  const days = eventType === "reminder_3d"
    ? 3
    : eventType === "reminder_2d"
    ? 2
    : 1;
  return {
    subject: days === 1
      ? "Final balance reminder - 24 hours remaining"
      : `${days} days remaining to settle your balance`,
    heading: days === 1 ? "FINAL BALANCE REMINDER" : `${days} DAYS REMAINING`,
    accent: days === 1 ? "#c83d26" : "#143d63",
    message: `Your remaining balance of <strong>${
      php(balance)
    }</strong> must be paid by <strong>${esc(phDateTime(deadline))}</strong>. ${
      days === 1
        ? "If payment is not completed within 24 hours, the reservation will be forfeited and the slot will be released."
        : "Please settle the balance before the deadline to keep your reservation."
    }`,
  };
}

function emailHtml(
  info: ReturnType<typeof summary>,
  eventType: string,
): string {
  const copy = noticeCopy(eventType, info.balance, info.deadline);
  return `<!doctype html><html><body style="margin:0;background:#eef3f6;font-family:Arial,sans-serif;color:#0f2438">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
  <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background:#fff;border:1px solid #d7e0e6;border-radius:18px;overflow:hidden;box-shadow:0 14px 40px rgba(20,61,99,.12)">
    <tr><td style="background:#0b2744;padding:24px 30px;text-align:center"><img src="${LOGO_URL}" width="72" height="72" alt="Paddle Rage Pickleball" style="border-radius:50%;background:#fff;padding:2px;border:2px solid #c9cf43"><div style="color:#ffffff;font-weight:900;letter-spacing:2px;margin-top:10px">PADDLE RAGE PICKLEBALL</div><div style="color:#c9cf43;font-size:11px;letter-spacing:1px;margin-top:4px">IPONAN, CAGAYAN DE ORO</div></td></tr>
    <tr><td style="height:5px;background:${copy.accent}"></td></tr>
    <tr><td style="padding:30px">
      <div style="font-size:12px;font-weight:900;letter-spacing:1.4px;color:${copy.accent}">${copy.heading}</div>
      <h1 style="font-size:24px;line-height:1.2;margin:8px 0 18px">Host court reservation</h1>
      <p style="font-size:15px;line-height:1.65;margin:0 0 20px">Hi <strong>${
    esc(info.name)
  }</strong>,</p>
      <p style="font-size:15px;line-height:1.65;margin:0 0 22px">${copy.message}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f8;border:1px solid #d7e0e6;border-radius:12px">
        <tr><td style="padding:15px 18px;border-bottom:1px solid #d7e0e6"><small style="color:#657486">Booking reference</small><br><strong>${
    esc(info.key)
  }</strong></td></tr>
        <tr><td style="padding:15px 18px;border-bottom:1px solid #d7e0e6"><small style="color:#657486">Court and schedule</small><br><strong>${
    esc(info.courts)
  }</strong><br>${info.schedules}</td></tr>
        <tr><td style="padding:15px 18px"><table width="100%"><tr><td><small style="color:#657486">Paid</small><br><strong>${
    php(info.paid)
  }</strong></td><td><small style="color:#657486">Remaining balance</small><br><strong style="color:${copy.accent}">${
    php(info.balance)
  }</strong></td></tr></table></td></tr>
      </table>
      ${
    eventType === "forfeited"
      ? ""
      : `<p style="font-size:13px;line-height:1.6;color:#657486;margin:20px 0 0">All payments are final and non-refundable. Contact Paddle Rage Pickleball or follow your original payment instructions to settle the balance.</p>`
  }
    </td></tr>
    <tr><td style="background:#0b2744;padding:16px 30px;text-align:center;color:#d6e1e9;font-size:12px">Automated account notice from Paddle Rage Pickleball</td></tr>
  </table></td></tr></table></body></html>`;
}

function emailPlain(
  info: ReturnType<typeof summary>,
  eventType: string,
): string {
  const copy = noticeCopy(eventType, info.balance, info.deadline);
  const action = eventType === "forfeited"
    ? `The remaining balance of PHP ${
      info.balance.toLocaleString("en-PH", { minimumFractionDigits: 2 })
    } was not paid by the deadline. The slot was released, and payments already made remain non-refundable.`
    : `Please pay the remaining balance of PHP ${
      info.balance.toLocaleString("en-PH", { minimumFractionDigits: 2 })
    } by ${phDateTime(info.deadline)} to keep the reservation.`;
  return `PADDLE RAGE PICKLEBALL\n${copy.heading}\n\nHi ${info.name},\n\n${action}\n\nBooking reference: ${info.key}\nCourt: ${info.courts}\nPaid: PHP ${
    info.paid.toLocaleString("en-PH", { minimumFractionDigits: 2 })
  }\nRemaining balance: PHP ${
    info.balance.toLocaleString("en-PH", { minimumFractionDigits: 2 })
  }\n\nPaddle Rage Pickleball\nIponan, Cagayan de Oro\nhttps://paddleragecdo.ph`;
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
      : "Notification claim was not acquired";
    return {
      skipped: true,
      reason,
      reasonCode: claim.reason,
      leaseExpiresAt: claim.leaseExpiresAt,
    };
  }

  const copy = noticeCopy(eventType, info.balance, info.deadline);
  let sent: { id: string };
  try {
    sent = await sendMailerooEmail({
      to: info.email,
      toName: info.name,
      subject: `${copy.subject} | Paddle Rage Pickleball`,
      html: emailHtml(info, eventType),
      plain: emailPlain(info, eventType),
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

    const results = [];
    const now = Date.now();
    for (const rows of groupRows((data || []) as BookingRow[])) {
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

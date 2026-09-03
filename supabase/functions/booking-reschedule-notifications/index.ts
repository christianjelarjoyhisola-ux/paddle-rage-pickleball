// deno-lint-ignore-file no-explicit-any no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  emailCorsHeaders,
  isAllowedEmailOrigin,
} from "../_shared/email-request.ts";
import { isEmailAddress, sendMailerooEmail } from "../_shared/maileroo.ts";
import { escapeHtml, formatDate } from "../_shared/paddle-rage-email.ts";
import {
  telegramChatIds,
  telegramConfigured,
} from "../_shared/telegram.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_CLAIM_BATCH = 4;
const LEASE_SECONDS = 180;
const TELEGRAM_TIMEOUT_MS = 12_000;
const ADMIN_ROLES = new Set(["owner", "court_owner"]);
const CUSTOMER_KINDS = new Set([
  "customer_request_received",
  "customer_approved",
  "customer_rejected",
  "customer_conflicted",
  "customer_withdrawn",
]);
const TELEGRAM_KIND = "admin_review_needed";

type DispatchBody = {
  action?: unknown;
  requestId?: unknown;
  bookingRef?: unknown;
  email?: unknown;
  accessToken?: unknown;
  limit?: unknown;
};

type ClaimedNotification = {
  id: string;
  requestId: string;
  eventId: number;
  kind: string;
  bookingRef: string;
  bookingGroupRef: string | null;
  customerName: string;
  customerEmail: string;
  requestStatus: string;
  oldSnapshot: Record<string, unknown>;
  requestedSnapshot: Record<string, unknown>;
  decisionReason: string | null;
  createdAt: string;
  deliveredRecipientKeys: string[];
};

type ScheduleItem = {
  ref: string;
  courtName: string;
  date: string;
  startTime: string;
  endTime: string;
};

class RequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...emailCorsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function plain(value: unknown, max = 500): string {
  return text(value, max).replace(/\s+/g, " ");
}

function uuid(value: unknown, field = "requestId"): string {
  const result = text(value, 80).toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(
        result,
      )
  ) {
    throw new RequestError(`${field} is invalid`, 400);
  }
  return result;
}

function bookingReference(value: unknown): string {
  const result = text(value, 80).toUpperCase();
  if (!/^PB-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(result)) {
    throw new RequestError("bookingRef is invalid", 400);
  }
  return result;
}

function guestAccessToken(value: unknown): string {
  const result = text(value, 80);
  if (!/^[0-9a-fA-F]{64}$/.test(result)) {
    throw new RequestError("Secure booking access is required", 403);
  }
  return result;
}

async function readBody(req: Request): Promise<DispatchBody> {
  const declaredBytes = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
    throw new RequestError("Request body is too large", 413);
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new RequestError("Request body is too large", 413);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as DispatchBody;
  } catch {
    throw new RequestError("Invalid JSON body", 400);
  }
}

async function activeAdminRole(req: Request, db: any): Promise<string> {
  const token = (req.headers.get("authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) return "";

  const { data: userData, error: userError } = await db.auth.getUser(token);
  const userId = text(userData?.user?.id, 80);
  if (userError || !userId) return "";

  const { data: account, error: accountError } = await db.from("accounts")
    .select("role,status")
    .eq("id", userId)
    .maybeSingle();
  if (accountError) throw new Error("Unable to verify administrator access");
  const role = text(account?.role, 30).toLowerCase();
  return account?.status === "active" && ADMIN_ROLES.has(role) ? role : "";
}

async function authorizeGuestRequest(
  db: any,
  body: DispatchBody,
  requestedId: string,
): Promise<void> {
  const ref = bookingReference(body.bookingRef);
  const email = text(body.email, 254).toLowerCase();
  const accessToken = guestAccessToken(body.accessToken);
  if (!isEmailAddress(email)) {
    throw new RequestError("email is invalid", 400);
  }

  const { data, error } = await db.rpc("get_public_booking_reschedule_state", {
    p_ref: ref,
    p_email: email,
    p_access_token: accessToken,
  });
  if (error) {
    console.error("Guest reschedule dispatch authorization failed", {
      code: text(error.code, 30),
    });
    throw new RequestError("Booking request could not be verified", 403);
  }
  const state = objectValue(data);
  const request = objectValue(state.request);
  if (text(request.id, 80).toLowerCase() !== requestedId) {
    throw new RequestError("Booking request could not be verified", 403);
  }
}

function scheduleItems(value: unknown): ScheduleItem[] {
  const snapshot = objectValue(value);
  const rawItems = Array.isArray(snapshot.items) ? snapshot.items : [];
  const rows = rawItems.map((raw) => objectValue(raw)).map((item) => ({
    ref: plain(item.ref, 100),
    courtName: plain(item.courtName ?? item.court_name, 120) || "Court",
    date: plain(item.date, 10),
    startTime: plain(item.startTime ?? item.start_time, 40),
    endTime: plain(item.endTime ?? item.end_time, 40),
  })).filter((item) => item.date && item.startTime && item.endTime);

  if (rows.length) return rows.slice(0, 12);
  const date = plain(snapshot.requestedDate ?? snapshot.date, 10);
  const startTime = plain(snapshot.startTime ?? snapshot.start_time, 40);
  const endTime = plain(snapshot.endTime ?? snapshot.end_time, 40);
  return date && startTime && endTime
    ? [{
      ref: "",
      courtName: plain(snapshot.courtName ?? snapshot.court_name, 120) ||
        "Court",
      date,
      startTime,
      endTime,
    }]
    : [];
}

function dateLabel(value: string): string {
  return value ? formatDate(value) : "Date unavailable";
}

function schedulePlain(items: ScheduleItem[]): string {
  if (!items.length) return "Schedule details unavailable";
  return items.map((item) =>
    `${item.courtName} | ${
      dateLabel(item.date)
    } | ${item.startTime} - ${item.endTime}`
  ).join("\n");
}

function scheduleHtml(items: ScheduleItem[]): string {
  if (!items.length) {
    return '<div style="color:#b7c0b5;font-size:14px;line-height:1.6;">Schedule details unavailable</div>';
  }
  return items.map((item) => `
    <div style="padding:12px 0;border-bottom:1px solid #29362c;">
      <div style="font-size:15px;line-height:1.45;font-weight:900;color:#f6f8f2;">${
    escapeHtml(item.courtName)
  }</div>
      <div style="margin-top:3px;font-size:13px;line-height:1.55;color:#b7c0b5;">${
    escapeHtml(dateLabel(item.date))
  }<br>${escapeHtml(item.startTime)} &ndash; ${escapeHtml(item.endTime)}</div>
    </div>`).join("");
}

function publicUrl(): string {
  const raw = text(
    Deno.env.get("APP_PUBLIC_URL") || "https://paddleragecdo.ph",
    500,
  ).replace(/\/+$/, "");
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new Error("unsafe protocol");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "https://paddleragecdo.ph";
  }
}

function adminUrl(): string {
  const fallback = `${publicUrl()}/admin.html#bookings`;
  try {
    const url = new URL(text(Deno.env.get("APP_ADMIN_URL") || fallback, 500));
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      return fallback;
    }
    url.hash = "bookings";
    return url.toString();
  } catch {
    return fallback;
  }
}

function emailCopy(kind: string): {
  subject: string;
  status: string;
  statusColor: string;
  statusBackground: string;
  title: string;
  intro: string;
  currentLabel: string;
  requestedLabel: string;
  note: string;
} {
  switch (kind) {
    case "customer_request_received":
      return {
        subject: "Reschedule request received",
        status: "PENDING REVIEW",
        statusColor: "#ffdf75",
        statusBackground: "#211b08",
        title: "We received your schedule request",
        intro:
          "Your current booking stays confirmed while the Paddle Rage team reviews the requested schedule.",
        currentLabel: "CURRENT SCHEDULE",
        requestedLabel: "REQUESTED SCHEDULE",
        note:
          "The requested time is not reserved until it is approved. We will email you after the review.",
      };
    case "customer_approved":
      return {
        subject: "Reschedule request approved",
        status: "NEW SCHEDULE CONFIRMED",
        statusColor: "#d7ff3f",
        statusBackground: "#172006",
        title: "Your booking has been rescheduled",
        intro:
          "Your new court schedule is confirmed. The previous schedule is no longer active.",
        currentLabel: "PREVIOUS SCHEDULE",
        requestedLabel: "CONFIRMED SCHEDULE",
        note:
          "Please arrive on time and present your booking reference if asked.",
      };
    case "customer_rejected":
      return {
        subject: "Reschedule request update",
        status: "REQUEST NOT APPROVED",
        statusColor: "#ff8a8f",
        statusBackground: "#241012",
        title: "Your original booking is unchanged",
        intro:
          "The requested schedule change was not approved. Your existing court schedule remains active.",
        currentLabel: "ACTIVE SCHEDULE",
        requestedLabel: "REQUESTED SCHEDULE",
        note:
          "You may contact Paddle Rage if you need help with another eligible schedule.",
      };
    case "customer_conflicted":
      return {
        subject: "Choose another reschedule time",
        status: "REQUESTED TIME UNAVAILABLE",
        statusColor: "#ffdf75",
        statusBackground: "#211b08",
        title: "Your original booking is still confirmed",
        intro:
          "The requested schedule became unavailable before approval, so no booking details were changed.",
        currentLabel: "ACTIVE SCHEDULE",
        requestedLabel: "UNAVAILABLE REQUEST",
        note: "Open Manage booking to request a different available schedule.",
      };
    case "customer_withdrawn":
      return {
        subject: "Reschedule request withdrawn",
        status: "REQUEST WITHDRAWN",
        statusColor: "#f6f8f2",
        statusBackground: "#1b211c",
        title: "Your schedule request was withdrawn",
        intro:
          "The pending schedule request has been removed. Your original booking remains active.",
        currentLabel: "ACTIVE SCHEDULE",
        requestedLabel: "WITHDRAWN REQUEST",
        note: "No changes were made to your court booking.",
      };
    default:
      throw new Error("Unsupported reschedule notification kind");
  }
}

function renderCustomerEmail(notification: ClaimedNotification): {
  subject: string;
  html: string;
  plain: string;
} {
  const copy = emailCopy(notification.kind);
  const displayRef = plain(
    notification.bookingGroupRef || notification.bookingRef,
    100,
  ).replace(/-G$/i, "");
  const name = plain(notification.customerName, 160) || "Player";
  const oldItems = scheduleItems(notification.oldSnapshot);
  const requestedItems = scheduleItems(notification.requestedSnapshot);
  const reason = plain(notification.decisionReason, 1000);
  const manageUrl = `${publicUrl()}/manage-booking.html`;
  const reasonHtml = reason && [
      "customer_rejected",
      "customer_conflicted",
    ].includes(notification.kind)
    ? `<div style="margin-top:18px;padding:15px 17px;border:1px solid #5b3d11;border-radius:12px;background:#211b08;color:#f6f8f2;font-size:14px;line-height:1.65;"><strong style="color:#ffdf75;">Review note</strong><br>${
      escapeHtml(reason)
    }</div>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${
    escapeHtml(copy.subject)
  } | Paddle Rage Pickleball</title><style>
    @media only screen and (max-width:620px){
      .email-wrap{padding:0!important}.email-card{border-radius:0!important;border-left:0!important;border-right:0!important}
      .mobile-pad{padding-left:21px!important;padding-right:21px!important}.schedule-cell{display:block!important;width:100%!important;box-sizing:border-box!important}
      .schedule-gap{display:block!important;width:100%!important;height:12px!important}.email-title{font-size:26px!important}
    }
  </style></head>
<body style="margin:0;padding:0;background:#050706;font-family:Arial,'Helvetica Neue',sans-serif;color:#f6f8f2;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${
    escapeHtml(copy.intro)
  }</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#050706;"><tr><td class="email-wrap" align="center" style="padding:30px 12px;">
    <table role="presentation" class="email-card" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#0b0f0c;border:1px solid #29362c;border-radius:18px;overflow:hidden;">
      <tr><td style="height:7px;background:#b6f000;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td class="mobile-pad" style="padding:24px 32px;background:#050706;border-bottom:1px solid #29362c;">
        <div style="font-size:22px;line-height:1.15;font-weight:900;letter-spacing:1.8px;color:#ffffff;">PADDLE RAGE</div>
        <div style="margin-top:4px;font-size:11px;font-weight:800;letter-spacing:2px;color:#b6f000;">PICKLEBALL &middot; CDO</div>
      </td></tr>
      <tr><td style="padding:11px 20px;text-align:center;background:${copy.statusBackground};color:${copy.statusColor};font-size:12px;font-weight:900;letter-spacing:1.2px;">${
    escapeHtml(copy.status)
  }</td></tr>
      <tr><td class="mobile-pad" style="padding:32px 34px 14px;">
        <h1 class="email-title" style="margin:0 0 14px;font-size:29px;line-height:1.2;color:#f6f8f2;">${
    escapeHtml(copy.title)
  }</h1>
        <p style="margin:0 0 8px;font-size:16px;line-height:1.65;color:#f6f8f2;">Hi <strong>${
    escapeHtml(name)
  }</strong>,</p>
        <p style="margin:0;font-size:15px;line-height:1.7;color:#b7c0b5;">${
    escapeHtml(copy.intro)
  }</p>
      </td></tr>
      <tr><td class="mobile-pad" style="padding:12px 34px 32px;">
        <div style="margin-bottom:18px;padding:14px 16px;border:1px solid #3b4d3f;border-radius:12px;background:#111712;">
          <div style="font-size:10px;font-weight:900;letter-spacing:1.4px;color:#9ca79d;">BOOKING REFERENCE</div>
          <div style="margin-top:6px;font-family:Consolas,'Courier New',monospace;font-size:18px;font-weight:900;color:#d7ff3f;overflow-wrap:anywhere;">${
    escapeHtml(displayRef)
  }</div>
        </div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td class="schedule-cell" style="width:50%;padding:16px;vertical-align:top;border:1px solid #29362c;border-radius:13px;background:#111712;">
            <div style="font-size:10px;font-weight:900;letter-spacing:1.2px;color:#9ca79d;">${
    escapeHtml(copy.currentLabel)
  }</div>${scheduleHtml(oldItems)}
          </td>
          <td class="schedule-gap" style="width:12px;font-size:0;">&nbsp;</td>
          <td class="schedule-cell" style="width:50%;padding:16px;vertical-align:top;border:1px solid #516b11;border-radius:13px;background:#172006;">
            <div style="font-size:10px;font-weight:900;letter-spacing:1.2px;color:#b6f000;">${
    escapeHtml(copy.requestedLabel)
  }</div>${scheduleHtml(requestedItems)}
          </td>
        </tr></table>
        ${reasonHtml}
        <div style="margin-top:19px;padding:15px 17px;border-left:4px solid #b6f000;border-radius:8px;background:#151d17;color:#dbe2d9;font-size:14px;line-height:1.65;">${
    escapeHtml(copy.note)
  }</div>
        <div style="margin-top:22px;text-align:center;"><a href="${
    escapeHtml(manageUrl)
  }" style="display:inline-block;padding:13px 20px;border-radius:10px;background:#b6f000;color:#050706;font-size:14px;font-weight:900;text-decoration:none;">Manage booking</a></div>
      </td></tr>
      <tr><td style="padding:21px 30px;background:#050706;border-top:1px solid #29362c;text-align:center;color:#9ca79d;font-size:12px;line-height:1.6;">
        Payments are non-refundable. Eligible reservations may be rescheduled under Paddle Rage booking rules.<br>
        <a href="${
    escapeHtml(publicUrl())
  }" style="color:#b6f000;text-decoration:none;font-weight:800;">paddleragecdo.ph</a>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const plainText = [
    "PADDLE RAGE PICKLEBALL",
    copy.status,
    "",
    `Hi ${name},`,
    copy.intro,
    "",
    `Booking reference: ${displayRef}`,
    "",
    `${copy.currentLabel}:`,
    schedulePlain(oldItems),
    "",
    `${copy.requestedLabel}:`,
    schedulePlain(requestedItems),
    ...(reason && ["customer_rejected", "customer_conflicted"].includes(
        notification.kind,
      )
      ? ["", `Review note: ${reason}`]
      : []),
    "",
    copy.note,
    `Manage booking: ${manageUrl}`,
    "",
    "Payments are non-refundable. Eligible reservations may be rescheduled under Paddle Rage booking rules.",
  ].join("\n");

  return {
    subject: `${copy.subject}: ${displayRef} | Paddle Rage Pickleball`,
    html,
    plain: plainText,
  };
}

function telegramEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function telegramBotToken(): string {
  return text(Deno.env.get("TELEGRAM_BOT_TOKEN"), 500);
}

async function telegramRecipientKey(
  chatId: string,
  botToken: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(botToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(chatId),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function sendTelegramRecipient(
  message: string,
  chatId: string,
  botToken: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
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
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      },
    );
  } catch (error) {
    if (
      error instanceof DOMException &&
      ["TimeoutError", "AbortError"].includes(error.name)
    ) {
      throw new Error("Telegram request timed out");
    }
    throw new Error("Unable to reach Telegram");
  }

  const payload = objectValue(await response.json().catch(() => ({})));
  if (!response.ok || payload.ok !== true) {
    let detail = `Telegram HTTP ${response.status}`;
    const description = plain(payload.description, 160);
    if (description) detail += `: ${description}`;
    throw new Error(detail);
  }
}

function telegramSchedule(items: ScheduleItem[]): string {
  if (!items.length) return "Schedule details unavailable";
  return items.map((item) =>
    `• ${telegramEscape(item.courtName)} · ${
      telegramEscape(dateLabel(item.date))
    } · ${telegramEscape(item.startTime)}–${telegramEscape(item.endTime)}`
  ).join("\n");
}

function telegramMessage(notification: ClaimedNotification): string {
  const displayRef = plain(
    notification.bookingGroupRef || notification.bookingRef,
    100,
  ).replace(/-G$/i, "");
  const oldItems = scheduleItems(notification.oldSnapshot);
  const requestedItems = scheduleItems(notification.requestedSnapshot);
  return [
    "🔄 <b>RESCHEDULE REQUEST</b>",
    `📋 Ref: <code>${telegramEscape(displayRef)}</code>`,
    "",
    "<b>FROM</b>",
    telegramSchedule(oldItems),
    "",
    "<b>TO</b>",
    telegramSchedule(requestedItems),
    "",
    "⏳ Pending owner review",
    `🔗 <a href="${
      telegramEscape(adminUrl())
    }">Open the Paddle Rage dashboard</a>`,
  ].join("\n");
}

function claimedNotification(value: unknown): ClaimedNotification {
  const row = objectValue(value);
  const deliveredRecipientKeys = Array.isArray(
      row.deliveredRecipientKeys ?? row.delivered_recipient_keys,
    )
    ? (row.deliveredRecipientKeys ?? row.delivered_recipient_keys) as unknown[]
    : [];
  return {
    id: uuid(row.id, "notification id"),
    requestId: uuid(row.requestId ?? row.request_id, "request id"),
    eventId: Number(row.eventId ?? row.event_id ?? 0),
    kind: text(row.kind ?? row.notification_kind, 80).toLowerCase(),
    bookingRef: text(row.bookingRef ?? row.booking_ref, 100),
    bookingGroupRef: text(
      row.bookingGroupRef ?? row.booking_group_ref,
      100,
    ) || null,
    customerName: text(row.customerName ?? row.customer_name, 160),
    customerEmail: text(row.customerEmail ?? row.customer_email, 254)
      .toLowerCase(),
    requestStatus: text(
      row.requestStatus ?? row.request_status,
      40,
    ).toLowerCase(),
    oldSnapshot: objectValue(row.oldSnapshot ?? row.old_snapshot),
    requestedSnapshot: objectValue(
      row.requestedSnapshot ?? row.requested_snapshot,
    ),
    decisionReason: text(
      row.decisionReason ?? row.decision_reason,
      1000,
    ) || null,
    createdAt: text(row.createdAt ?? row.created_at, 80),
    deliveredRecipientKeys: [...new Set(deliveredRecipientKeys.map((key) =>
      text(key, 64).toLowerCase()
    ).filter((key) => /^[0-9a-f]{64}$/.test(key)))],
  };
}

async function recordTelegramRecipient(
  db: any,
  notificationId: string,
  leaseToken: string,
  recipientKey: string,
  succeeded: boolean,
  errorMessage: string | null,
): Promise<void> {
  const { data, error } = await db.rpc(
    "record_booking_reschedule_notification_recipient",
    {
      p_notification_id: notificationId,
      p_lease_token: leaseToken,
      p_recipient_key: recipientKey,
      p_succeeded: succeeded,
      p_error: errorMessage ? errorMessage.slice(0, 1800) : null,
    },
  );
  if (error) {
    throw new Error(
      error.message || "Unable to record Telegram recipient delivery",
    );
  }
  const result = typeof data === "boolean" ? { ok: data } : objectValue(data);
  if (result.ok !== true) {
    throw new Error("Telegram recipient delivery lease is no longer owned");
  }
}

async function finishNotification(
  db: any,
  notificationId: string,
  leaseToken: string,
  succeeded: boolean,
  errorMessage: string | null,
): Promise<void> {
  const { data, error } = await db.rpc(
    "finish_booking_reschedule_notification",
    {
      p_notification_id: notificationId,
      p_lease_token: leaseToken,
      p_succeeded: succeeded,
      p_error: errorMessage ? errorMessage.slice(0, 1800) : null,
    },
  );
  if (error) throw new Error(error.message || "Unable to finish notification");
  const result = typeof data === "boolean" ? { ok: data } : objectValue(data);
  if (result.ok !== true) {
    throw new Error("Notification lease is no longer owned by this worker");
  }
}

async function deliverNotification(
  notification: ClaimedNotification,
  db: any,
  leaseToken: string,
): Promise<void> {
  // Submission notices can still be leased after the request was superseded,
  // withdrawn, or reviewed. Complete those rows without rendering or sending
  // stale "pending review" content.
  if (
    ["customer_request_received", TELEGRAM_KIND].includes(notification.kind) &&
    notification.requestStatus !== "pending"
  ) return;

  const oldItems = scheduleItems(notification.oldSnapshot);
  const requestedItems = scheduleItems(notification.requestedSnapshot);
  if (!notification.bookingRef || !oldItems.length || !requestedItems.length) {
    throw new Error("Canonical reschedule notification data is incomplete");
  }

  if (CUSTOMER_KINDS.has(notification.kind)) {
    if (!isEmailAddress(notification.customerEmail)) {
      throw new Error("Canonical customer email is missing or invalid");
    }
    const content = renderCustomerEmail(notification);
    await sendMailerooEmail({
      to: notification.customerEmail,
      toName: notification.customerName || "Player",
      subject: content.subject,
      html: content.html,
      plain: content.plain,
      tags: {
        message_type: notification.kind.replace(/_/g, "-"),
        booking_reference: plain(
          notification.bookingGroupRef || notification.bookingRef,
          100,
        ).replace(/-G$/i, ""),
      },
    });
    return;
  }

  if (notification.kind === TELEGRAM_KIND) {
    if (!telegramConfigured() || !telegramChatIds().length) {
      throw new Error("Telegram review notifications are not configured");
    }
    const botToken = telegramBotToken();
    const deliveredKeys = new Set(notification.deliveredRecipientKeys);
    const message = telegramMessage(notification);
    const recipients = telegramChatIds();
    const results = await Promise.all(recipients.map(async (chatId) => {
      const recipientKey = await telegramRecipientKey(chatId, botToken);
      if (deliveredKeys.has(recipientKey)) {
        return { ok: true, skipped: true };
      }

      try {
        await sendTelegramRecipient(message, chatId, botToken);
      } catch (error) {
        const deliveryError = error instanceof Error
          ? error.message
          : "Unknown Telegram delivery error";
        try {
          await recordTelegramRecipient(
            db,
            notification.id,
            leaseToken,
            recipientKey,
            false,
            deliveryError,
          );
        } catch (recordError) {
          const recordMessage = recordError instanceof Error
            ? recordError.message
            : "Unable to record recipient failure";
          return {
            ok: false,
            error: `${deliveryError}; ${recordMessage}`,
          };
        }
        return { ok: false, error: deliveryError };
      }

      // Recording a success is idempotent, so retry the database write once.
      // This narrows the unavoidable provider-success/process-crash window
      // without ever sending the Telegram message a second time here.
      let recordError = "Unable to record Telegram recipient delivery";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await recordTelegramRecipient(
            db,
            notification.id,
            leaseToken,
            recipientKey,
            true,
            null,
          );
          return { ok: true, skipped: false };
        } catch (error) {
          recordError = error instanceof Error ? error.message : recordError;
        }
      }
      return { ok: false, error: recordError };
    }));
    const failures = results.filter((result) => !result.ok);
    if (failures.length) {
      const sent = results.length - failures.length;
      throw new Error(
        `Telegram review notification delivered to ${sent} recipient(s) and failed for ${failures.length}`,
      );
    }
    return;
  }

  throw new Error("Unsupported reschedule notification kind");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return isAllowedEmailOrigin(req)
      ? new Response(null, {
        status: 204,
        headers: {
          ...emailCorsHeaders(req),
          "Cache-Control": "no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      })
      : new Response("Origin not allowed", {
        status: 403,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
  }
  if (req.method !== "POST") {
    return json(req, { ok: false, error: "Method not allowed" }, 405);
  }
  if (!isAllowedEmailOrigin(req)) {
    return json(req, { ok: false, error: "Origin not allowed" }, 403);
  }

  try {
    const supabaseUrl = text(Deno.env.get("SUPABASE_URL"), 1000);
    const serviceKey = text(
      Deno.env.get("SERVICE_ROLE_KEY") ||
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
      5000,
    );
    if (!supabaseUrl || !serviceKey) {
      throw new RequestError("Notification service is not configured", 503);
    }
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const body = await readBody(req);
    const action = text(body.action || "dispatch", 30).toLowerCase();
    if (!new Set(["dispatch", "retry"]).has(action)) {
      throw new RequestError("Invalid notification action", 400);
    }

    const role = await activeAdminRole(req, db);
    const requestedId = body.requestId ? uuid(body.requestId) : null;
    if (!role) {
      if (action !== "dispatch" || !requestedId) {
        throw new RequestError("Active owner access is required", 403);
      }
      await authorizeGuestRequest(db, body, requestedId);
    }

    if (action === "retry") {
      if (!requestedId) {
        throw new RequestError("requestId is required to retry delivery", 400);
      }
      const { data: retryData, error: retryError } = await db.rpc(
        "retry_booking_reschedule_notifications",
        { p_request_id: requestedId },
      );
      if (retryError) {
        throw new Error(
          retryError.message || "Unable to prepare notifications for retry",
        );
      }
      const retryResult = objectValue(retryData);
      if (retryResult.ok !== true) {
        throw new Error("Unable to prepare notifications for retry");
      }
    }

    const requestedLimit = Number(body.limit || MAX_CLAIM_BATCH);
    const limit = role
      ? Math.max(
        1,
        Math.min(
          Number.isFinite(requestedLimit) ? requestedLimit : MAX_CLAIM_BATCH,
          MAX_CLAIM_BATCH,
        ),
      )
      : MAX_CLAIM_BATCH;
    const workerId = `reschedule-edge:${crypto.randomUUID()}`;
    const { data: claimData, error: claimError } = await db.rpc(
      "claim_booking_reschedule_notifications",
      {
        p_worker_id: workerId,
        p_limit: limit,
        p_lease_seconds: LEASE_SECONDS,
        p_request_id: requestedId,
      },
    );
    if (claimError) {
      throw new Error(claimError.message || "Unable to claim notifications");
    }
    const claim = objectValue(claimData);
    if (claim.ok === false) {
      throw new Error(
        plain(claim.error, 500) || "Unable to claim notifications",
      );
    }
    const rawNotifications = Array.isArray(claim.notifications)
      ? claim.notifications
      : [];
    if (!rawNotifications.length) {
      return json(req, {
        ok: true,
        skipped: true,
        reason: "No notifications are ready",
      });
    }
    const leaseToken = uuid(
      claim.leaseToken ?? claim.lease_token,
      "lease token",
    );
    const notifications = rawNotifications.map(claimedNotification);
    let delivered = 0;
    let failed = 0;

    for (const notification of notifications) {
      try {
        if (requestedId && notification.requestId !== requestedId) {
          throw new Error(
            "Claim returned a notification outside the requested scope",
          );
        }
        await deliverNotification(notification, db, leaseToken);
        await finishNotification(db, notification.id, leaseToken, true, null);
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Reschedule notification delivery failed", {
          notificationId: notification.id,
          kind: notification.kind,
          error: message.slice(0, 500),
        });
        try {
          await finishNotification(
            db,
            notification.id,
            leaseToken,
            false,
            message,
          );
        } catch (finishError) {
          console.error("Unable to release reschedule notification lease", {
            notificationId: notification.id,
            error: finishError instanceof Error
              ? finishError.message.slice(0, 500)
              : "Unknown completion error",
          });
        }
        failed += 1;
      }
    }

    return json(req, {
      ok: failed === 0,
      processed: notifications.length,
      delivered,
      failed,
      ...(failed ? { error: "One or more notifications need retry" } : {}),
    }, failed ? 503 : 200);
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof RequestError
      ? error.message
      : "Notification delivery is temporarily unavailable";
    if (!(error instanceof RequestError)) {
      console.error(
        "booking-reschedule-notifications failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    return json(req, { ok: false, error: message }, status);
  }
});

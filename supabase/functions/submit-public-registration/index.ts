import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  parseTurnstileHostnames,
  PUBLIC_REGISTRATION_TURNSTILE_ACTION,
  turnstileRemoteIp,
  verifyTurnstileToken,
} from "../_shared/turnstile.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DIGITAL_METHODS = new Set([
  "gcash",
  "bdopay",
  "maya",
  "bpi",
  "gotyme",
  "pnb",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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

function adminUrl(): string {
  return Deno.env.get("APP_ADMIN_URL") ||
    "https://paddleragecdo.ph/admin.html";
}

async function sendCanonicalTelegram(
  db: any,
  event: {
    key: string;
    type: "open_play_registration" | "host_session_registration";
    subjectId: string;
    message: string;
  },
): Promise<Record<string, unknown>> {
  const botToken = text(Deno.env.get("TELEGRAM_BOT_TOKEN"), 500);
  const chatIds = text(Deno.env.get("TELEGRAM_CHAT_ID"), 1000)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!botToken || !chatIds.length) {
    return { ok: true, skipped: true, reason: "Telegram not configured" };
  }

  const { error: claimError } = await db
    .from("notification_event_claims")
    .insert({
      event_key: event.key,
      event_type: "created",
      subject_type: event.type,
      subject_id: event.subjectId,
    });
  if (claimError) {
    if (String(claimError.code || "") === "23505") {
      return {
        ok: true,
        skipped: true,
        reason: "Notification already claimed",
      };
    }
    console.error("registration notification claim failed", claimError.message);
    return { ok: false, skipped: true, reason: "Notification claim failed" };
  }

  const results = await Promise.allSettled(chatIds.map(async (chatId) => {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: event.message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Telegram HTTP ${response.status}`);
    }
  }));
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) {
    console.error("registration Telegram delivery failed", failed);
  }
  if (failed.length === chatIds.length) {
    await db.from("notification_event_claims").delete().eq(
      "event_key",
      event.key,
    );
  }
  return {
    ok: failed.length === 0,
    sent: chatIds.length - failed.length,
    failed: failed.length,
  };
}

function openPlayMessage(row: Record<string, unknown>): string {
  return (
    `<b>OPEN PLAY SIGN-UP</b>\n` +
    `------------------\n` +
    `<b>${esc(row.full_name)}</b>\n\n` +
    `<b>${esc(row.court_name)}</b>\n` +
    `${esc(fmtDate(row.date))}\n` +
    `${esc(row.time_label)}\n\n` +
    `Payment: <b>${esc(row.payment_type)}</b> - ${fmtPHP(row.amount)}\n` +
    `Method: <b>${esc(row.payment_method)}</b>\n` +
    `Status: <b>${esc(row.payment_status)}</b>\n` +
    `------------------\n` +
    `<a href="${adminUrl()}">View Open Play registrations.</a>`
  );
}

function hostSessionMessage(
  registration: Record<string, unknown>,
  session: Record<string, unknown>,
): string {
  return (
    `<b>HOST SESSION SIGN-UP</b>\n` +
    `------------------\n` +
    `<b>${esc(registration.full_name)}</b>\n` +
    `${esc(registration.contact_number || "")}\n\n` +
    `<b>${esc(session.title || "Open Play Session")}</b>\n` +
    `${esc(fmtDate(session.date))}\n` +
    `${esc(session.start_hour)}:00 - ${esc(session.end_hour)}:00\n\n` +
    `Amount: <b>${fmtPHP(registration.amount)}</b>\n` +
    `Method: <b>${esc(registration.payment_method)}</b>\n` +
    `Status: <b>${esc(registration.payment_status)}</b>\n` +
    `------------------\n` +
    `<a href="${adminUrl()}">Open the Host Center.</a>`
  );
}

async function requireRegistrationTurnstile(
  req: Request,
  token: unknown,
): Promise<Response | null> {
  const result = await verifyTurnstileToken({
    token,
    secret: Deno.env.get("TURNSTILE_SECRET_KEY"),
    remoteIp: turnstileRemoteIp(req),
    expectedAction: PUBLIC_REGISTRATION_TURNSTILE_ACTION,
    allowedHostnames: parseTurnstileHostnames(
      Deno.env.get("TURNSTILE_EXPECTED_HOSTNAMES"),
    ),
  });
  if (result.ok) return null;
  const status = result.reason === "server-misconfigured" ||
      result.reason === "verification-unavailable"
    ? 503
    : 403;
  return json({
    ok: false,
    code: `TURNSTILE_${result.reason.replaceAll("-", "_").toUpperCase()}`,
    error: result.reason === "missing-token"
      ? "Complete the secure human verification before submitting this registration."
      : "Secure human verification failed. Please try again.",
  }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 64 * 1024) {
    return json({ ok: false, error: "Request is too large" }, 413);
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const action = text(body.action, 40);
    if (!["open_play", "host_session"].includes(action)) {
      return json({ ok: false, error: "Unsupported registration action" }, 400);
    }

    const paymentMethod = text(body.paymentMethod || "cash", 30).toLowerCase();
    if (paymentMethod !== "cash" && !DIGITAL_METHODS.has(paymentMethod)) {
      return json({ ok: false, error: "Unsupported payment method" }, 400);
    }
    // Every registration is challenged here. Digital receipt verification has
    // its own independent action/token, and free host sessions can otherwise
    // be disguised as a digital payment by a caller-controlled method.
    const denial = await requireRegistrationTurnstile(req, body.turnstileToken);
    if (denial) return denial;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceKey) {
      return json({
        ok: false,
        error: "Registration service is not configured",
      }, 503);
    }
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (action === "open_play") {
      const { data, error } = await db.rpc(
        "submit_public_open_play_registration",
        {
          p_full_name: text(body.fullName, 150),
          p_court_id: text(body.courtId, 100),
          p_date: text(body.date, 10),
          p_hour: Number(body.hour),
          p_payment_type: "100%",
          p_payment_method: paymentMethod,
          p_gcash_ref: text(body.gcashRef, 100) || null,
          p_receipt_image_url: text(body.receiptImageUrl, 300) || null,
          p_client_receipt_status: text(body.receiptStatus || "none", 30),
        },
      );
      if (error) return json({ ok: false, error: error.message }, 409);
      const saved = Array.isArray(data) ? data[0] : data;
      if (!saved?.id) {
        return json({ ok: false, error: "Registration was not saved" }, 500);
      }

      const { data: row, error: rowError } = await db
        .from("open_play_registrations")
        .select(
          "id,full_name,court_id,court_name,date,hour,time_label,payment_type,payment_method,payment_status,amount,receipt_status,created_at",
        )
        .eq("id", saved.id)
        .single();
      if (rowError || !row) {
        return json({
          ok: false,
          error: "Saved registration could not be loaded",
        }, 500);
      }

      const notification = await sendCanonicalTelegram(db, {
        key: `registration:open_play:${row.id}`,
        type: "open_play_registration",
        subjectId: String(row.id),
        message: openPlayMessage(row),
      });
      return json({ ok: true, registration: row, notification });
    }

    const { data, error } = await db.rpc(
      "submit_public_host_session_registration",
      {
        p_session_id: text(body.sessionId, 50),
        p_full_name: text(body.fullName, 150),
        p_contact_number: text(body.contactNumber, 40) || null,
        p_payment_method: paymentMethod,
        p_gcash_ref: text(body.gcashRef, 100) || null,
        p_receipt_image_url: text(body.receiptImageUrl, 300) || null,
        p_client_receipt_status: text(body.receiptStatus || "none", 30),
      },
    );
    if (error) return json({ ok: false, error: error.message }, 409);
    const saved = Array.isArray(data) ? data[0] : data;
    if (!saved?.id) {
      return json({ ok: false, error: "Registration was not saved" }, 500);
    }

    const { data: registration, error: registrationError } = await db
      .from("open_play_host_session_registrations")
      .select(
        "id,session_id,full_name,contact_number,payment_method,gcash_ref,payment_status,amount,receipt_status,created_at",
      )
      .eq("id", saved.id)
      .single();
    if (registrationError || !registration) {
      return json({
        ok: false,
        error: "Saved registration could not be loaded",
      }, 500);
    }
    const { data: session, error: sessionError } = await db
      .from("open_play_host_sessions")
      .select("id,title,date,start_hour,end_hour,court_names,host_name")
      .eq("id", registration.session_id)
      .single();
    if (sessionError || !session) {
      return json(
        { ok: false, error: "Host session could not be loaded" },
        500,
      );
    }

    const notification = await sendCanonicalTelegram(db, {
      key: `registration:host_session:${registration.id}`,
      type: "host_session_registration",
      subjectId: String(registration.id),
      message: hostSessionMessage(registration, session),
    });
    return json({ ok: true, registration, session, notification });
  } catch (error) {
    console.error("submit-public-registration failed", error);
    return json(
      { ok: false, error: "Registration could not be submitted" },
      500,
    );
  }
});

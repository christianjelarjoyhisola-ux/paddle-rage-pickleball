import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  "maribank",
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

function positiveReceiptVerificationId(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

function fmtDateTime(value: unknown): string {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  });
}

function adminUrl(): string {
  return Deno.env.get("APP_ADMIN_URL") ||
    "https://paddleragecdo.ph/admin.html";
}

function registrationNeedsReview(row: Record<string, unknown>): boolean {
  const method = text(row.payment_method, 30).toLowerCase();
  const receipt = text(row.receipt_status, 30).toLowerCase();
  const payment = text(row.payment_status, 30).toLowerCase();
  return method !== "cash" &&
    (receipt === "manual_review" ||
      ["pending", "for_verification"].includes(payment));
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
    `⚠️ <b>PAYMENT REVIEW</b>\n` +
    `👤 ${esc(row.full_name)} · ${fmtPHP(row.amount)}\n` +
    `🏓 Open Play · #${esc(row.id)}\n` +
    `💳 ${esc(text(row.payment_method, 30).toUpperCase())} · Booked ${
      esc(fmtDateTime(row.created_at))
    }\n` +
    `📅 Starts ${esc(fmtDate(row.date))} · ${esc(row.time_label)}\n` +
    `<a href="${adminUrl()}">Open the Paddle Rage dashboard</a>`
  );
}

function hostSessionMessage(
  registration: Record<string, unknown>,
  session: Record<string, unknown>,
): string {
  return (
    `⚠️ <b>PAYMENT REVIEW</b>\n` +
    `👤 ${esc(registration.full_name)} · ${fmtPHP(registration.amount)}\n` +
    `🏓 ${esc(session.title || "Host session")} · #${
      esc(registration.id)
    }\n` +
    `💳 ${
      esc(text(registration.payment_method, 30).toUpperCase())
    } · Booked ${esc(fmtDateTime(registration.created_at))}\n` +
    `📅 Starts ${esc(fmtDate(session.date))} · ${
      esc(`${session.start_hour}:00`)
    }\n` +
    `<a href="${adminUrl()}">Open the Paddle Rage dashboard</a>`
  );
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
      const receiptVerificationId = paymentMethod === "cash"
        ? null
        : positiveReceiptVerificationId(body.receiptVerificationId);
      const commonArgs = {
        p_full_name: text(body.fullName, 150),
        p_court_id: text(body.courtId, 100),
        p_date: text(body.date, 10),
        p_hour: Number(body.hour),
        p_payment_type: "100%",
        p_payment_method: paymentMethod,
        p_gcash_ref: text(body.gcashRef, 100) || null,
        p_receipt_image_url: text(body.receiptImageUrl, 300) || null,
      };
      let verifiedReceiptAccepted = false;
      const response = receiptVerificationId
        ? await db.rpc("submit_verified_public_open_play_registration", {
          ...commonArgs,
          p_receipt_verification_id: receiptVerificationId,
        })
        : await db.rpc("submit_public_open_play_registration", {
          ...commonArgs,
          p_client_receipt_status: paymentMethod === "cash"
            ? "none"
            : "manual_review",
        });
      if (receiptVerificationId && response.error) {
        // Never start a second legacy insert after attempting a verified RPC.
        // A lost response can be ambiguous even when PostgreSQL committed, so
        // falling back here could create both a paid and a pending registration.
        console.warn(
          "Open Play verified registration failed:",
          response.error.message,
        );
        return json({
          ok: false,
          error:
            "Verified registration could not be finalized. Please retry the same submission.",
          retryable: true,
        }, 409);
      } else if (receiptVerificationId) {
        verifiedReceiptAccepted = true;
      }
      const { data, error } = response;
      if (error) return json({ ok: false, error: error.message }, 409);
      const saved = Array.isArray(data) ? data[0] : data;
      if (!saved?.id) {
        return json({ ok: false, error: "Registration was not saved" }, 500);
      }

      const { data: row, error: rowError } = await db
        .from("open_play_registrations")
        .select(
          "id,full_name,court_id,court_name,date,hour,time_label,payment_type,payment_method,payment_status,amount,receipt_status,receipt_verification_id,created_at",
        )
        .eq("id", saved.id)
        .single();
      if (rowError || !row) {
        return json({
          ok: false,
          error: "Saved registration could not be loaded",
        }, 500);
      }

      const notification = registrationNeedsReview(row)
        ? await sendCanonicalTelegram(db, {
          key: `telegram:payment_review_needed:open_play:${row.id}`,
          type: "open_play_registration",
          subjectId: String(row.id),
          message: openPlayMessage(row),
        })
        : {
          ok: true,
          skipped: true,
          reason: "Registration does not need payment review",
        };
      return json({
        ok: true,
        registration: row,
        notification,
        verifiedReceiptAccepted,
      });
    }

    const receiptVerificationId = paymentMethod === "cash"
      ? null
      : positiveReceiptVerificationId(body.receiptVerificationId);
    const commonArgs = {
      p_session_id: text(body.sessionId, 50),
      p_full_name: text(body.fullName, 150),
      p_contact_number: text(body.contactNumber, 40) || null,
      p_payment_method: paymentMethod,
      p_gcash_ref: text(body.gcashRef, 100) || null,
      p_receipt_image_url: text(body.receiptImageUrl, 300) || null,
    };
    let verifiedReceiptAccepted = false;
    const response = receiptVerificationId
      ? await db.rpc("submit_verified_public_host_session_registration", {
        ...commonArgs,
        p_receipt_verification_id: receiptVerificationId,
      })
      : await db.rpc("submit_public_host_session_registration", {
        ...commonArgs,
        p_client_receipt_status: paymentMethod === "cash"
          ? "none"
          : "manual_review",
      });
    if (receiptVerificationId && response.error) {
      console.warn(
        "Host-session verified registration failed:",
        response.error.message,
      );
      return json({
        ok: false,
        error:
          "Verified registration could not be finalized. Please retry the same submission.",
        retryable: true,
      }, 409);
    } else if (receiptVerificationId) {
      verifiedReceiptAccepted = true;
    }
    const { data, error } = response;
    if (error) return json({ ok: false, error: error.message }, 409);
    const saved = Array.isArray(data) ? data[0] : data;
    if (!saved?.id) {
      return json({ ok: false, error: "Registration was not saved" }, 500);
    }

    const { data: registration, error: registrationError } = await db
      .from("open_play_host_session_registrations")
      .select(
        "id,session_id,full_name,contact_number,payment_method,gcash_ref,payment_status,amount,receipt_status,receipt_verification_id,created_at",
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

    const notification = registrationNeedsReview(registration)
      ? await sendCanonicalTelegram(db, {
        key:
          `telegram:payment_review_needed:host_session:${registration.id}`,
        type: "host_session_registration",
        subjectId: String(registration.id),
        message: hostSessionMessage(registration, session),
      })
      : {
        ok: true,
        skipped: true,
        reason: "Registration does not need payment review",
      };
    return json({
      ok: true,
      registration,
      session,
      notification,
      verifiedReceiptAccepted,
    });
  } catch (error) {
    console.error("submit-public-registration failed", error);
    return json(
      { ok: false, error: "Registration could not be submitted" },
      500,
    );
  }
});

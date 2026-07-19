import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  calculateCourtPayment,
  closeMoney,
  roundMoney,
} from "../_shared/booking-payment.ts";

type CreatePayload = {
  bookingRef: string;
  bookingAccessToken?: string;
  amountPhp?: number;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  metadata?: Record<string, string>;
};

type BookingRow = {
  ref: string;
  booking_group_ref: string | null;
  full_name: string | null;
  email: string | null;
  contact_number: string | null;
  court_id: string;
  slots: Array<string | number> | null;
  total: number | null;
  downpayment: number | null;
  host_booking: boolean;
  status: string | null;
  payment_status: string | null;
  customer_access_token_hash: string | null;
  host_user_id: string | null;
  created_by_user_id: string | null;
};

type CourtRow = {
  rate: number | null;
  rate_schedule: unknown;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function extractErrMsg(err: unknown) {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const maybe = err as Record<string, unknown>;
    if (typeof maybe.message === "string") return maybe.message;
    if (typeof maybe.error === "string") return maybe.error;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

function settingMap(rows: Array<{ key: string; value: string }> | null) {
  const out: Record<string, string> = {};
  (rows || []).forEach((row) => {
    out[row.key] = row.value;
  });
  return out;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function loadActiveCaller(req: Request, db: any): Promise<
  {
    userId: string;
    role: string;
  } | null
> {
  const token = (req.headers.get("Authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  const userId = String(data?.user?.id || "").trim();
  if (error || !userId) return null;
  const { data: account, error: accountError } = await db
    .from("accounts")
    .select("role,status")
    .eq("id", userId)
    .maybeSingle();
  if (accountError || account?.status !== "active") return null;
  return { userId, role: String(account.role || "").toLowerCase() };
}

function expectedBookingAmounts(
  booking: BookingRow,
  court: CourtRow,
  settings: Record<string, string>,
) {
  return calculateCourtPayment({
    slots: booking.slots,
    courtRate: court.rate,
    courtRateSchedule: court.rate_schedule,
    fallbackRateSchedule: settings.pricing_tiers,
    feeRate: settings.maintenance_fee ?? settings.service_fee_rate ??
      settings.booking_fee,
    feeType: settings.fee_type,
    storedDownpayment: booking.downpayment,
    hostBooking: booking.host_booking === true,
    paymentAcceptanceMode: settings.payment_acceptance_mode,
  });
}

async function loadBookingGroup(
  db: any,
  booking: BookingRow,
): Promise<BookingRow[]> {
  if (!booking.booking_group_ref) return [booking];
  const { data, error } = await db
    .from("bookings")
    .select(
      "ref,booking_group_ref,full_name,email,contact_number,court_id,slots,total,downpayment,host_booking,status,payment_status,customer_access_token_hash,host_user_id,created_by_user_id",
    )
    .eq("booking_group_ref", booking.booking_group_ref)
    .neq("status", "cancelled");
  if (error) throw error;
  return (data || []) as BookingRow[];
}

async function expectedBookingGroupAmounts(
  db: any,
  bookings: BookingRow[],
  settings: Record<string, string>,
) {
  let total = 0;
  let due = 0;
  for (const row of bookings) {
    const { data: court, error: courtErr } = await db
      .from("courts")
      .select("rate,rate_schedule")
      .eq("id", row.court_id)
      .single();
    if (courtErr || !court) throw courtErr || new Error("Court not found");
    const amounts = expectedBookingAmounts(row, court as CourtRow, settings);
    total += amounts.total;
    due += amounts.due;
  }
  return { total: roundMoney(total), due: roundMoney(due) };
}

async function createPayMongoCheckoutSession(input: {
  secretKey: string;
  amountPhp: number;
  bookingRef: string;
  customer: { name: string; email: string; phone: string };
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}) {
  const amountCents = Math.round(input.amountPhp * 100);
  const auth = btoa(`${input.secretKey}:`);

  const body = {
    data: {
      attributes: {
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
        payment_method_types: ["qrph", "paymaya"],
        line_items: [
          {
            currency: "PHP",
            amount: amountCents,
            name: `Booking ${input.bookingRef}`,
            quantity: 1,
            description: `Payment for booking ${input.bookingRef}`,
          },
        ],
        reference_number: input.bookingRef,
        description: `Payment for ${input.bookingRef}`,
        metadata: input.metadata,
        billing: {
          name: input.customer.name,
          email: input.customer.email,
          phone: input.customer.phone,
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
    },
  };

  const res = await fetch("https://api.paymongo.com/v1/checkout_sessions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`PayMongo error ${res.status}: ${extractErrMsg(json)}`);
  }

  const sessionId = json?.data?.id || null;
  const checkoutUrl = json?.data?.attributes?.checkout_url || null;
  if (!sessionId || !checkoutUrl) {
    throw new Error("PayMongo response missing session id or checkout_url");
  }

  return { sessionId, checkoutUrl };
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      "";
    if (!serviceRoleKey) throw new Error("Missing SERVICE_ROLE_KEY");
    const provider = (Deno.env.get("PAYMENT_PROVIDER") || "paymongo")
      .toLowerCase();
    const db = createClient(supabaseUrl, serviceRoleKey);

    const body = (await req.json()) as CreatePayload;
    const bookingRef = String(body.bookingRef || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,99}$/.test(bookingRef)) {
      return new Response(JSON.stringify({ error: "Invalid payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: booking, error: bookingErr } = await db
      .from("bookings")
      .select(
        "ref,booking_group_ref,full_name,email,contact_number,court_id,slots,total,downpayment,host_booking,status,payment_status,customer_access_token_hash,host_user_id,created_by_user_id",
      )
      .eq("ref", bookingRef)
      .single();
    if (bookingErr || !booking) {
      return new Response(JSON.stringify({ error: "Booking not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const bookingGroup = await loadBookingGroup(db, booking as BookingRow);
    const bookingAccessToken = String(body.bookingAccessToken || "");
    const suppliedTokenHash = bookingAccessToken.length >= 32 &&
        bookingAccessToken.length <= 256
      ? await sha256Hex(bookingAccessToken)
      : "";
    const customerAuthorized = !!suppliedTokenHash &&
      bookingGroup.every((row) =>
        /^[0-9a-f]{64}$/.test(String(row.customer_access_token_hash || "")) &&
        constantTimeEqual(
          suppliedTokenHash,
          String(row.customer_access_token_hash || ""),
        )
      );
    const caller = customerAuthorized ? null : await loadActiveCaller(req, db);
    const privileged = !!caller &&
      ["owner", "court_owner", "staff"].includes(caller.role);
    const owningHost = !!caller && caller.role === "host" &&
      bookingGroup.every((row) =>
        row.host_user_id === caller.userId ||
        row.created_by_user_id === caller.userId
      );
    if (!customerAuthorized && !privileged && !owningHost) {
      return new Response(
        JSON.stringify({
          error: "Checkout is not authorized for this booking",
        }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    if (
      bookingGroup.some((row) =>
        row.status === "cancelled" || row.status === "forfeited" ||
        row.payment_status === "paid" ||
        row.payment_status === "downpayment_paid" ||
        row.payment_status === "deposit_retained"
      )
    ) {
      return new Response(JSON.stringify({ error: "Booking is not payable" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: settingRows, error: settingsErr } = await db.from("settings")
      .select("key,value");
    if (settingsErr) throw settingsErr;
    const settings = settingMap(
      settingRows as Array<{ key: string; value: string }>,
    );
    const amounts = await expectedBookingGroupAmounts(
      db,
      bookingGroup,
      settings,
    );

    const requestedAmount = Number(body.amountPhp);
    if (
      Number.isFinite(requestedAmount) &&
      !closeMoney(requestedAmount, amounts.due)
    ) {
      return new Response(
        JSON.stringify({
          error: "Payment amount does not match booking price",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const sessionId = crypto.randomUUID();
    const amountPhp = amounts.due;
    const customer = {
      name: booking.full_name || "Customer",
      email: booking.email || "",
      phone: booking.contact_number || "",
    };
    const metadata = {
      booking_ref: bookingRef,
      ...(booking.booking_group_ref
        ? { booking_group_ref: booking.booking_group_ref }
        : {}),
    };

    let checkoutUrl = "";
    let providerSessionId = sessionId;
    let providerName = provider;

    if (provider !== "paymongo") {
      throw new Error("Only PAYMENT_PROVIDER=paymongo is supported");
    }

    const secretKey = Deno.env.get("PAYMONGO_SECRET_KEY") || "";
    const successUrl = Deno.env.get("PAYMENT_SUCCESS_URL") || "";
    const cancelUrl = Deno.env.get("PAYMENT_CANCEL_URL") || "";
    if (!secretKey) throw new Error("PAYMONGO_SECRET_KEY is missing");
    if (!successUrl || !cancelUrl) {
      throw new Error("PAYMENT_SUCCESS_URL or PAYMENT_CANCEL_URL is missing");
    }

    const out = await createPayMongoCheckoutSession({
      secretKey,
      amountPhp,
      bookingRef,
      customer,
      successUrl,
      cancelUrl,
      metadata,
    });
    providerSessionId = out.sessionId;
    checkoutUrl = out.checkoutUrl;
    providerName = "paymongo";

    const nowIso = new Date().toISOString();
    const paymentRow = {
      id: sessionId,
      booking_ref: bookingRef,
      provider: providerName,
      provider_reference: providerSessionId,
      amount_php: amountPhp,
      status: "pending",
      checkout_url: checkoutUrl,
      raw_request: {
        booking_ref: bookingRef,
        requested_amount_php: Number.isFinite(requestedAmount)
          ? requestedAmount
          : null,
        authorization: customerAuthorized
          ? "booking_access_token"
          : privileged
          ? "operator"
          : "owning_host",
      },
      created_at: nowIso,
      updated_at: nowIso,
    };

    const { error: sessErr } = await db.from("payment_sessions").insert(
      paymentRow,
    );
    if (sessErr) throw sessErr;

    const bookingUpdate = {
      payment_status: "pending",
      payment_provider: providerName,
      payment_session_id: sessionId,
      payment_checkout_url: checkoutUrl,
    };
    const bookingRefs = bookingGroup.map((row) => row.ref);
    const { error: bErr } = await db.from("bookings").update(bookingUpdate)
      .in("ref", bookingRefs)
      .in("status", ["verifying", "pending"])
      .not("payment_status", "in", "(paid,downpayment_paid,deposit_retained)");
    if (bErr) throw bErr;

    return new Response(
      JSON.stringify({
        ok: true,
        provider: providerName,
        sessionId: sessionId,
        providerSessionId,
        checkoutUrl,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: extractErrMsg(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

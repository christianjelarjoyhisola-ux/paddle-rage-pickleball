const MAILEROO_ENDPOINT = "https://smtp.maileroo.com/api/v2/emails";
const DEFAULT_FROM_NAME = "Paddle Rage Pickleball";

export type MailerooEmail = {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  plain: string;
  tags?: Record<string, string>;
};

type MailerooResponse = {
  success?: boolean;
  message?: string;
  data?: {
    reference_id?: string;
  } | null;
};

export type MailerooSendResult = {
  id: string;
};

export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function requiredEnv(name: string): string {
  const value = (Deno.env.get(name) || "").trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function safeProviderMessage(value: unknown): string {
  const message = typeof value === "string" ? value.trim() : "";
  return message ? message.slice(0, 300) : "Request rejected";
}

/**
 * Sends one transactional email through Maileroo's HTTPS Email API.
 * API credentials remain server-side in Supabase Edge Function secrets.
 */
export async function sendMailerooEmail(
  email: MailerooEmail,
  fetcher: typeof fetch = fetch,
): Promise<MailerooSendResult> {
  const apiKey = requiredEnv("MAILEROO_API_KEY");
  const fromAddress = requiredEnv("MAILEROO_FROM_ADDRESS").toLowerCase();
  const fromName =
    (Deno.env.get("MAILEROO_FROM_NAME") || DEFAULT_FROM_NAME).trim() ||
    DEFAULT_FROM_NAME;
  const replyTo = (Deno.env.get("MAILEROO_REPLY_TO") || "").trim()
    .toLowerCase();
  const to = String(email.to || "").trim().toLowerCase();

  if (!isEmailAddress(fromAddress)) {
    throw new Error("MAILEROO_FROM_ADDRESS is invalid");
  }
  if (replyTo && !isEmailAddress(replyTo)) {
    throw new Error("MAILEROO_REPLY_TO is invalid");
  }
  if (!isEmailAddress(to)) {
    throw new Error("Recipient email address is invalid");
  }
  if (!email.subject.trim() || email.subject.length > 255) {
    throw new Error("Email subject is invalid");
  }
  if (!email.html.trim() || !email.plain.trim()) {
    throw new Error("Email content is incomplete");
  }

  const payload: Record<string, unknown> = {
    from: { address: fromAddress, display_name: fromName },
    to: [{
      address: to,
      ...(email.toName?.trim()
        ? { display_name: email.toName.trim().slice(0, 160) }
        : {}),
    }],
    subject: email.subject,
    html: email.html,
    plain: email.plain,
    // Booking messages contain no marketing links. Disabling tracking avoids
    // unnecessary tracking pixels and keeps these notices purely transactional.
    tracking: false,
    ...(email.tags && Object.keys(email.tags).length
      ? { tags: email.tags }
      : {}),
  };
  if (replyTo) payload.reply_to = { address: replyTo, display_name: fromName };

  let response: Response;
  try {
    response = await fetcher(MAILEROO_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("Maileroo request timed out");
    }
    throw new Error("Unable to reach Maileroo");
  }

  const result = await response.json().catch(() => ({})) as MailerooResponse;
  if (!response.ok || result.success === false) {
    throw new Error(
      `Maileroo error ${response.status}: ${
        safeProviderMessage(result.message)
      }`,
    );
  }

  const id = String(result.data?.reference_id || "").trim();
  if (!id) {
    throw new Error("Maileroo accepted the request without a reference ID");
  }
  return { id };
}

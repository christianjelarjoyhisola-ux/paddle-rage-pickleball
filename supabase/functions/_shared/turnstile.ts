export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const RECEIPT_OCR_TURNSTILE_ACTION = "receipt_ocr";
export const PUBLIC_REGISTRATION_TURNSTILE_ACTION = "public_registration";
export const HOST_APPLICATION_TURNSTILE_ACTION = "host_application";

const MAX_TOKEN_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 8000;

export type TurnstileFailureReason =
  | "missing-token"
  | "invalid-token"
  | "server-misconfigured"
  | "verification-unavailable";

export type TurnstileVerification =
  | {
    ok: true;
    action: string;
    hostname: string;
  }
  | {
    ok: false;
    reason: TurnstileFailureReason;
    errorCodes: string[];
  };

type TurnstileSiteverifyResponse = {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
  "error-codes"?: unknown;
};

export type VerifyTurnstileOptions = {
  token: unknown;
  secret: unknown;
  remoteIp?: unknown;
  expectedAction?: string;
  allowedHostnames?: readonly string[];
  fetcher?: typeof fetch;
  timeoutMs?: number;
  idempotencyKey?: string;
};

function normalizedHostname(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

export function parseTurnstileHostnames(value: unknown): string[] {
  return [
    ...new Set(
      String(value || "")
        .split(",")
        .map(normalizedHostname)
        .filter((hostname) =>
          hostname.length > 0 && hostname.length <= 253 &&
          !hostname.includes("://") && !hostname.includes("/")
        ),
    ),
  ];
}

/**
 * Keep only a plausible bare IP address. The value is a signal passed to
 * Cloudflare, never an authorization decision made by this application.
 */
export function normalizeClientIp(value: unknown): string {
  let candidate = String(value || "").split(",", 1)[0].trim();
  const bracketed = candidate.match(/^\[([0-9a-f:.]+)\](?::\d{1,5})?$/i);
  if (bracketed) candidate = bracketed[1];
  if (
    !candidate || candidate.length > 45 || !/^[0-9a-f:.]+$/i.test(candidate)
  ) {
    return "";
  }

  if (!candidate.includes(":")) {
    const octets = candidate.split(".");
    if (
      octets.length !== 4 ||
      octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
    ) return "";
    return candidate;
  }

  // IPv6 may contain an embedded IPv4 tail. The character/length checks above
  // plus these structural guards prevent header fragments from being forwarded.
  if ((candidate.match(/::/g) || []).length > 1) return "";
  const pieces = candidate.split(":");
  if (pieces.length < 3 || pieces.length > 8) return "";
  if (
    pieces.some((part) =>
      part && !/^[0-9a-f]{1,4}$/i.test(part) &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(part)
    )
  ) {
    return "";
  }
  return candidate;
}

export function turnstileRemoteIp(req: Request): string {
  for (
    const header of [
      "cf-connecting-ip",
      "true-client-ip",
      "x-real-ip",
      "x-forwarded-for",
    ]
  ) {
    const ip = normalizeClientIp(req.headers.get(header));
    if (ip) return ip;
  }
  return "";
}

function responseErrorCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((code) => String(code || "").trim())
    .filter(Boolean)
    .slice(0, 10);
}

export async function verifyTurnstileToken(
  options: VerifyTurnstileOptions,
): Promise<TurnstileVerification> {
  const token = String(options.token || "").trim();
  if (!token) {
    return {
      ok: false,
      reason: "missing-token",
      errorCodes: ["missing-input-response"],
    };
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return {
      ok: false,
      reason: "invalid-token",
      errorCodes: ["invalid-input-response"],
    };
  }

  const secret = String(options.secret || "").trim();
  if (!secret) {
    return {
      ok: false,
      reason: "server-misconfigured",
      errorCodes: ["missing-input-secret"],
    };
  }

  const form = new URLSearchParams({
    secret,
    response: token,
    idempotency_key: options.idempotencyKey || crypto.randomUUID(),
  });
  const remoteIp = normalizeClientIp(options.remoteIp);
  if (remoteIp) form.set("remoteip", remoteIp);

  const controller = new AbortController();
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await (options.fetcher || fetch)(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: controller.signal,
    });
  } catch {
    return {
      ok: false,
      reason: "verification-unavailable",
      errorCodes: ["siteverify-request-failed"],
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: "verification-unavailable",
      errorCodes: [`siteverify-http-${response.status}`],
    };
  }

  let result: TurnstileSiteverifyResponse;
  try {
    result = await response.json() as TurnstileSiteverifyResponse;
  } catch {
    return {
      ok: false,
      reason: "verification-unavailable",
      errorCodes: ["siteverify-invalid-json"],
    };
  }

  if (result.success !== true) {
    const errorCodes = responseErrorCodes(result["error-codes"]);
    return {
      ok: false,
      reason: "invalid-token",
      errorCodes: errorCodes.length ? errorCodes : ["invalid-input-response"],
    };
  }

  const expectedAction = String(
    options.expectedAction || RECEIPT_OCR_TURNSTILE_ACTION,
  ).trim();
  const action = String(result.action || "").trim();
  if (!action || action !== expectedAction) {
    return {
      ok: false,
      reason: "invalid-token",
      errorCodes: ["action-mismatch"],
    };
  }

  const hostname = normalizedHostname(result.hostname);
  const allowedHostnames = (options.allowedHostnames || [])
    .map(normalizedHostname)
    .filter(Boolean);
  if (allowedHostnames.length && !allowedHostnames.includes(hostname)) {
    return {
      ok: false,
      reason: "invalid-token",
      errorCodes: ["hostname-mismatch"],
    };
  }

  return { ok: true, action, hostname };
}

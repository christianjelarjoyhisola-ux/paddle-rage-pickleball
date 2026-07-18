const DEFAULT_ORIGINS = [
  "https://paddleragecdo.ph",
  "https://www.paddleragecdo.ph",
  "https://paddle-rage-pickleball.pages.dev",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
];

function normalizedOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return "";
  }
}

function allowedOrigins(): Set<string> {
  const configured = (Deno.env.get("EMAIL_ALLOWED_ORIGINS") || "")
    .split(",")
    .map((value) => normalizedOrigin(value.trim()))
    .filter(Boolean);
  const appOrigin = normalizedOrigin(Deno.env.get("APP_PUBLIC_URL") || "");
  return new Set([
    ...DEFAULT_ORIGINS,
    ...configured,
    ...(appOrigin ? [appOrigin] : []),
  ]);
}

export function isAllowedEmailOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  // Server-to-server calls do not send Origin. Caller authorization and
  // booking validation remain the actual security boundary.
  return !origin || allowedOrigins().has(normalizedOrigin(origin));
}

export function emailCorsHeaders(req: Request): Record<string, string> {
  const requestedOrigin = normalizedOrigin(req.headers.get("origin") || "");
  const allowOrigin = requestedOrigin && allowedOrigins().has(requestedOrigin)
    ? requestedOrigin
    : "https://paddleragecdo.ph";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...emailCorsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function isAdminEmailRequest(
  req: Request,
  db: any,
): Promise<boolean> {
  const token = (req.headers.get("authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  ).trim();
  if (!token) return false;
  const { data: userData, error: userError } = await db.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userError || !userId) return false;
  const { data: account, error: accountError } = await db.from("accounts")
    .select("role,status")
    .eq("id", userId)
    .maybeSingle();
  return !accountError && account?.status === "active" &&
    ["owner", "court_owner", "staff"].includes(String(account.role || ""));
}

export async function requireAdminEmailRequest(
  req: Request,
  db: any,
): Promise<void> {
  if (!await isAdminEmailRequest(req, db)) {
    throw new Error("Admin access required");
  }
}

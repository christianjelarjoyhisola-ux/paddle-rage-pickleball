// deno-lint-ignore-file no-explicit-any no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMailerooEmail } from "../_shared/maileroo.ts";
import {
  renderHostDecisionEmail,
  renderHostVerificationEmail,
} from "../_shared/paddle-rage-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_ID_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const ALLOWED_ID_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

type SignupPayload = {
  action?:
    | "signup"
    | "resend-verification"
    | "sign-valid-id"
    | "review"
    | "repair-activation";
  applicationId?: string;
  status?: "approved" | "rejected";
  reviewNote?: string;
  fullName?: string;
  contactNumber?: string;
  email?: string;
  password?: string;
  gcashNumber?: string;
  validIdBase64?: string;
  validIdFileName?: string;
  validIdFileType?: string;
  validIdFileSize?: number;
  preferredSchedule?: string;
  notes?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clean(value: unknown) {
  return String(value || "").trim();
}

function errMsg(err: unknown) {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const maybe = err as Record<string, unknown>;
    if (typeof maybe.message === "string") return maybe.message;
    if (typeof maybe.error === "string") return maybe.error;
  }
  return String(err || "Unknown error");
}

function base64ToBytes(b64: string) {
  const comma = b64.indexOf(",");
  const raw = b64.startsWith("data:") && comma !== -1
    ? b64.slice(comma + 1)
    : b64;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function validPhone(value: string) {
  return /^(09|\+639)\d{9}$/.test(value.replace(/[\s-]/g, ""));
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeExt(fileName: string, contentType: string) {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && ["jpg", "jpeg", "png", "webp", "pdf"].includes(ext)) return ext;
  if (contentType === "application/pdf") return "pdf";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

async function readJson(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function apiError(data: unknown, fallback: string) {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.msg === "string") return obj.msg;
  }
  return fallback;
}

class RequestBodyError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

async function readJsonBody(req: Request): Promise<SignupPayload> {
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new RequestBodyError("Request body is too large", 413);
  }
  if (!req.body) throw new RequestBodyError("Invalid JSON body", 400);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestBodyError("Request body is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as SignupPayload;
  } catch {
    throw new RequestBodyError("Invalid JSON body", 400);
  }
}

function signupMeta(hostUserId: string, gcashNumber: string, reviewNote = "") {
  return JSON.stringify({ hostUserId, gcashNumber, reviewNote });
}

function parseSignupMeta(value: unknown) {
  if (typeof value !== "string" || !value.trim().startsWith("{")) {
    return { hostUserId: "", gcashNumber: "", reviewNote: "" };
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      hostUserId: typeof parsed.hostUserId === "string"
        ? parsed.hostUserId
        : "",
      gcashNumber: typeof parsed.gcashNumber === "string"
        ? parsed.gcashNumber
        : "",
      reviewNote: typeof parsed.reviewNote === "string"
        ? parsed.reviewNote
        : "",
    };
  } catch {
    return { hostUserId: "", gcashNumber: "", reviewNote: "" };
  }
}

type HostApplicationRecord = Record<string, unknown>;

type LoadedHostApplication = {
  app: HostApplicationRecord;
  legacySchema: boolean;
  meta: ReturnType<typeof parseSignupMeta>;
};

type ExistingAccount = {
  id: string;
  username: string;
  full_name: string;
  email: string;
  role: string;
  status: string;
  created_at: string | null;
};

class HostActivationError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "HostActivationError";
    this.status = status;
  }
}

function normalizedEmail(value: unknown) {
  return clean(value).toLowerCase();
}

// This standalone function has no generated Database type.
async function loadHostApplication(
  db: any,
  applicationId: string,
): Promise<LoadedHostApplication> {
  const modern = await db
    .from("open_play_host_applications")
    .select(
      "id, host_user_id, full_name, email, gcash_number, status, review_note",
    )
    .eq("id", applicationId)
    .single();

  let app = modern.data as HostApplicationRecord | null;
  let error = modern.error;
  let legacySchema = false;
  if (error && /host_user_id|gcash_number/i.test(error.message || "")) {
    legacySchema = true;
    const legacy = await db
      .from("open_play_host_applications")
      .select("id, full_name, email, status, review_note")
      .eq("id", applicationId)
      .single();
    app = legacy.data as HostApplicationRecord | null;
    error = legacy.error;
  }
  if (error || !app) {
    throw new HostActivationError("Host application not found", 404);
  }
  return { app, legacySchema, meta: parseSignupMeta(app.review_note) };
}

// Supabase Auth does not expose an exact-email admin lookup, so scan its
// paginated admin list and compare normalized emails exactly.
async function authUsersByExactEmail(
  db: any,
  email: string,
): Promise<Array<Record<string, unknown>>> {
  const matches: Array<Record<string, unknown>> = [];
  const perPage = 1000;
  let page = 1;

  while (true) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new HostActivationError(
        `Could not search host Auth account: ${errMsg(error)}`,
      );
    }
    const users = Array.isArray(data?.users)
      ? data.users as Array<Record<string, unknown>>
      : [];
    for (const user of users) {
      if (normalizedEmail(user.email) === email) matches.push(user);
    }

    const nextPage = Number(data?.nextPage || 0);
    const lastPage = Number(data?.lastPage || page);
    if (!nextPage && page >= lastPage) break;
    const followingPage = nextPage || page + 1;
    if (followingPage <= page || page > 10000) {
      throw new HostActivationError(
        "Could not safely finish Auth account lookup",
      );
    }
    page = followingPage;
  }
  return matches;
}

async function resolveUniqueHostAuthUser(
  db: any,
  loaded: LoadedHostApplication,
): Promise<Record<string, unknown>> {
  const appEmail = normalizedEmail(loaded.app.email);
  if (!validEmail(appEmail)) {
    throw new HostActivationError("Application email is invalid", 409);
  }

  const modernId = clean(loaded.app.host_user_id);
  const legacyId = clean(loaded.meta.hostUserId);
  const linkedIds = [...new Set([modernId, legacyId].filter(Boolean))];
  if (linkedIds.length > 1) {
    throw new HostActivationError(
      "Application has conflicting linked Auth accounts",
      409,
    );
  }

  let linkedUser: Record<string, unknown> | null = null;
  if (linkedIds[0]) {
    const { data, error } = await db.auth.admin.getUserById(linkedIds[0]);
    if (!error && data?.user) linkedUser = data.user as Record<string, unknown>;
    if (linkedUser && normalizedEmail(linkedUser.email) !== appEmail) {
      throw new HostActivationError(
        "Linked Auth account email does not match the application",
        409,
      );
    }
  }

  const emailMatches = await authUsersByExactEmail(db, appEmail);
  if (emailMatches.length === 0) {
    throw new HostActivationError(
      "No existing Auth login matches this application email",
      409,
    );
  }
  if (emailMatches.length > 1) {
    throw new HostActivationError(
      "Multiple Auth logins match this application email",
      409,
    );
  }
  const emailUser = emailMatches[0];
  if (linkedUser && clean(linkedUser.id) !== clean(emailUser.id)) {
    throw new HostActivationError(
      "Linked Auth account conflicts with the email login",
      409,
    );
  }
  return linkedUser || emailUser;
}

async function safeExistingHostAccount(
  db: any,
  userId: string,
  email: string,
): Promise<ExistingAccount | null> {
  const { data: byId, error: byIdError } = await db
    .from("accounts")
    .select("id, username, full_name, email, role, status, created_at")
    .eq("id", userId)
    .maybeSingle();
  if (byIdError) {
    throw new HostActivationError(
      `Could not inspect host account: ${errMsg(byIdError)}`,
    );
  }

  const existing = byId as ExistingAccount | null;
  if (existing && existing.role !== "host") {
    throw new HostActivationError(
      "This Auth login already belongs to a non-host account",
      409,
    );
  }
  if (existing?.email && normalizedEmail(existing.email) !== email) {
    throw new HostActivationError(
      "Linked account email does not match the application",
      409,
    );
  }

  const { data: emailRows, error: emailError } = await db
    .from("accounts")
    .select("id")
    .eq("email", email)
    .limit(2);
  if (emailError) {
    throw new HostActivationError(
      `Could not validate host email: ${errMsg(emailError)}`,
    );
  }
  if (
    (emailRows || []).some((row: { id?: string }) => clean(row.id) !== userId)
  ) {
    throw new HostActivationError(
      "Application email is linked to a different dashboard account",
      409,
    );
  }
  return existing;
}

async function rollbackHostActivation(
  db: any,
  userId: string,
  originalMetadata: Record<string, unknown>,
  originalAccount: ExistingAccount | null,
  accountChanged: boolean,
  authChanged: boolean,
): Promise<string[]> {
  const failures: string[] = [];
  if (accountChanged) {
    const rollback = originalAccount
      ? await db.from("accounts").upsert(originalAccount, { onConflict: "id" })
      : await db.from("accounts").delete().eq("id", userId);
    if (rollback.error) {
      failures.push(`account rollback: ${errMsg(rollback.error)}`);
      // A suspended row is safer than leaving a newly-active orphan account.
      try {
        const { data: suspended, error: suspendError } = await db
          .from("accounts")
          .update({ status: "suspended" })
          .eq("id", userId)
          .select("id, status")
          .maybeSingle();
        if (suspendError || suspended?.status !== "suspended") {
          failures.push(
            `fail-safe suspension: ${
              errMsg(suspendError || "account was not suspended")
            }`,
          );
        }
      } catch (suspendError) {
        failures.push(`fail-safe suspension: ${errMsg(suspendError)}`);
      }
    }
  }
  if (authChanged) {
    const { error } = await db.auth.admin.updateUserById(userId, {
      user_metadata: originalMetadata,
    });
    if (error) failures.push(`Auth rollback: ${errMsg(error)}`);
  }
  return failures;
}

async function activateHostApplication(
  db: any,
  loaded: LoadedHostApplication,
  options: {
    reviewerId: string;
    reviewNote: string;
    markApproved: boolean;
  },
) {
  const app = loaded.app;
  const appEmail = normalizedEmail(app.email);
  const appFullName = clean(app.full_name);
  const gcashNumber = clean(app.gcash_number) || loaded.meta.gcashNumber;
  const authUser = await resolveUniqueHostAuthUser(db, loaded);
  const userId = clean(authUser.id);
  if (!userId) {
    throw new HostActivationError("Resolved Auth login has no id", 409);
  }

  const originalMetadata =
    authUser.user_metadata && typeof authUser.user_metadata === "object"
      ? { ...(authUser.user_metadata as Record<string, unknown>) }
      : {};
  const existingMetadataRole = clean(originalMetadata.role);
  const existingAppRole =
    authUser.app_metadata && typeof authUser.app_metadata === "object"
      ? clean((authUser.app_metadata as Record<string, unknown>).role)
      : "";
  if (
    (existingMetadataRole && existingMetadataRole !== "host") ||
    (existingAppRole && !["authenticated", "host"].includes(existingAppRole))
  ) {
    throw new HostActivationError(
      "This Auth login already belongs to a non-host identity",
      409,
    );
  }
  const originalEmailConfirmed = Boolean(
    authUser.email_confirmed_at || authUser.confirmed_at,
  );
  if (!originalEmailConfirmed) {
    throw new HostActivationError(
      "The applicant must verify email ownership before host access can be approved",
      409,
    );
  }
  const originalAccount = await safeExistingHostAccount(db, userId, appEmail);
  const username = clean(originalAccount?.username) || appEmail;
  let authChanged = false;
  let accountChanged = false;

  try {
    const { error: authError } = await db.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...originalMetadata,
        full_name: appFullName,
        username,
        role: "host",
        account_status: "active",
      },
    });
    if (authError) {
      throw new HostActivationError(
        `Could not activate host login: ${errMsg(authError)}`,
      );
    }
    authChanged = true;

    const { error: accountError } = await db.from("accounts").upsert({
      id: userId,
      username,
      full_name: appFullName,
      email: appEmail,
      role: "host",
      status: "active",
    }, { onConflict: "id" });
    if (accountError) {
      throw new HostActivationError(
        `Could not activate host account: ${errMsg(accountError)}`,
      );
    }
    accountChanged = true;

    const { data: verifiedAuth, error: verifiedAuthError } = await db.auth.admin
      .getUserById(userId);
    const verifiedMeta = verifiedAuth?.user?.user_metadata || {};
    if (
      verifiedAuthError || !verifiedAuth?.user ||
      normalizedEmail(verifiedAuth.user.email) !== appEmail ||
      !verifiedAuth.user.email_confirmed_at || verifiedMeta.role !== "host" ||
      verifiedMeta.account_status !== "active"
    ) {
      throw new HostActivationError(
        "Host Auth activation could not be verified",
      );
    }
    const { data: verifiedAccount, error: verifiedAccountError } = await db
      .from("accounts")
      .select("id, role, status, email")
      .eq("id", userId)
      .maybeSingle();
    if (
      verifiedAccountError || !verifiedAccount ||
      verifiedAccount.role !== "host" ||
      verifiedAccount.status !== "active" ||
      normalizedEmail(verifiedAccount.email) !== appEmail
    ) {
      throw new HostActivationError(
        "Active host dashboard account could not be verified",
      );
    }

    const applicationUpdate: Record<string, unknown> = {};
    if (loaded.legacySchema) {
      applicationUpdate.review_note = signupMeta(
        userId,
        gcashNumber,
        options.reviewNote,
      );
    } else {
      applicationUpdate.host_user_id = userId;
      if (gcashNumber) applicationUpdate.gcash_number = gcashNumber;
      if (options.markApproved) {
        applicationUpdate.review_note = options.reviewNote;
      }
    }
    if (options.markApproved) {
      applicationUpdate.status = "approved";
      applicationUpdate.reviewed_by = options.reviewerId;
      applicationUpdate.reviewed_at = new Date().toISOString();
    }

    let applicationQuery = db
      .from("open_play_host_applications")
      .update(applicationUpdate)
      .eq("id", clean(app.id));
    applicationQuery = options.markApproved
      ? applicationQuery.eq("status", clean(app.status))
      : applicationQuery.eq("status", "approved");
    const { data: updatedApplication, error: applicationError } =
      await applicationQuery
        .select("id")
        .maybeSingle();
    if (applicationError) {
      throw new HostActivationError(
        `Could not link approved host application: ${errMsg(applicationError)}`,
      );
    }
    if (!updatedApplication) {
      throw new HostActivationError(
        "Host application changed during activation",
        409,
      );
    }

    return { hostUserId: userId, accountStatus: "active" as const };
  } catch (error) {
    const rollbackFailures = await rollbackHostActivation(
      db,
      userId,
      originalMetadata,
      originalAccount,
      accountChanged,
      authChanged,
    );
    if (rollbackFailures.length > 0) {
      console.error(
        "host activation rollback incomplete:",
        rollbackFailures.join("; "),
      );
      throw new HostActivationError(
        `${errMsg(error)}. Activation rollback needs administrator review.`,
      );
    }
    if (error instanceof HostActivationError) throw error;
    throw new HostActivationError(errMsg(error));
  }
}

type ReviewerResult = { error: Response } | { user: { id: string } };

// This standalone function has no generated Database type, and it supports
// both modern and pre-migration query shapes.
async function requireReviewer(req: Request, db: any): Promise<ReviewerResult> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: json({ error: "Unauthorized" }, 401) };

  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { error: json({ error: "Unauthorized" }, 401) };
  }

  const { data: account, error: accountErr } = await db
    .from("accounts")
    .select("role, status")
    .eq("id", userData.user.id)
    .single();

  const accountRow = account as { role?: string; status?: string } | null;
  if (
    accountErr || !accountRow || accountRow.status !== "active" ||
    !["owner", "court_owner"].includes(accountRow.role || "")
  ) {
    return {
      error: json({
        error:
          "Only an active owner or court owner can manage host applications",
      }, 403),
    };
  }

  return { user: userData.user };
}

Deno.serve(async (req): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Supabase service credentials are missing" }, 500);
  }

  const db = createClient(supabaseUrl, serviceRoleKey);

  const serviceHeaders = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
  };

  async function restSelect(table: string, filters: Record<string, string>) {
    const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
    url.searchParams.set("select", "id");
    url.searchParams.set("limit", "1");
    Object.entries(filters).forEach(([key, value]) =>
      url.searchParams.set(key, value)
    );
    const res = await fetch(url, { headers: serviceHeaders });
    const data = await readJson(res);
    if (!res.ok) {
      throw new Error(
        apiError(data, `Supabase REST select failed (${res.status})`),
      );
    }
    return Array.isArray(data) ? data : [];
  }

  async function restInsert(
    table: string,
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
    url.searchParams.set("select", "id");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...serviceHeaders,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(record),
    });
    const data = await readJson(res);
    if (!res.ok) {
      throw new Error(
        apiError(data, `Supabase REST insert failed (${res.status})`),
      );
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object") {
      throw new Error("Supabase REST insert did not return a row");
    }
    return row as Record<string, unknown>;
  }

  function hostVerificationRedirectUrl() {
    const appPublicUrl = (Deno.env.get("APP_PUBLIC_URL") ||
      "https://paddleragecdo.ph").replace(/\/+$/, "");
    return `${appPublicUrl}/host.html?email_verified=1`;
  }

  async function deliverHostVerificationEmail(
    recipientEmail: string,
    recipientName: string,
    verificationUrl: string,
    category: string,
  ) {
    const emailContent = renderHostVerificationEmail({
      fullName: recipientName,
      verificationUrl,
    });
    await sendMailerooEmail({
      to: recipientEmail,
      toName: recipientName,
      subject: "Verify your Paddle Rage host application",
      html: emailContent.html,
      plain: emailContent.plain,
      tags: { category },
    });
  }

  async function deliverHostDecisionEmail(
    app: HostApplicationRecord,
    status: "approved" | "rejected",
    reviewNote: string,
  ): Promise<boolean> {
    const recipientEmail = normalizedEmail(app.email);
    if (!validEmail(recipientEmail)) return false;
    const recipientName = clean(app.full_name) || "Host applicant";
    const emailContent = renderHostDecisionEmail({
      fullName: recipientName,
      status,
      reviewNote,
    });
    try {
      await sendMailerooEmail({
        to: recipientEmail,
        toName: recipientName,
        subject: `Host application ${status} | Paddle Rage Pickleball`,
        html: emailContent.html,
        plain: emailContent.plain,
        tags: { category: `host_application_${status}` },
      });
      return true;
    } catch (error) {
      console.error("Host decision email failed:", errMsg(error));
      return false;
    }
  }

  async function createAuthUser(
    email: string,
    password: string,
    fullName: string,
  ) {
    const hostMetadata = {
      full_name: fullName,
      username: email,
      role: "host",
      account_status: "pending",
    };
    const { data: created, error: createError } = await db.auth.admin
      .createUser({
        email,
        password,
        email_confirm: false,
        user_metadata: hostMetadata,
      });
    if (createError) {
      throw new Error(
        `Could not create host auth account: ${errMsg(createError)}`,
      );
    }
    const userId = clean(created?.user?.id);
    if (!userId) throw new Error("Host Auth account did not return an id");

    try {
      if (normalizedEmail(created?.user?.email) !== email) {
        throw new Error(
          "Host Auth account email did not match the application",
        );
      }
      const { data: linkData, error: linkError } = await db.auth.admin
        .generateLink({
          type: "signup",
          email,
          password,
          options: {
            data: hostMetadata,
            redirectTo: hostVerificationRedirectUrl(),
          },
        });
      const linkedUserId = clean(linkData?.user?.id);
      const verificationUrl = clean(linkData?.properties?.action_link);
      if (linkError || !verificationUrl || linkedUserId !== userId) {
        throw new Error(
          `Host email verification link was not created: ${errMsg(linkError)}`,
        );
      }
      await deliverHostVerificationEmail(
        email,
        fullName,
        verificationUrl,
        "host_email_verification",
      );
    } catch (provisionError) {
      const cleanupError = await deleteAuthUser(userId);
      throw new Error(
        `${errMsg(provisionError)}${
          cleanupError ? `. Auth cleanup also failed: ${cleanupError}` : ""
        }`,
      );
    }
    return userId;
  }

  async function deleteAuthUser(userId: string): Promise<string> {
    try {
      const { error } = await db.auth.admin.deleteUser(userId);
      return error ? errMsg(error) : "";
    } catch (error) {
      return errMsg(error);
    }
  }

  let body: SignupPayload;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return json({ error: errMsg(error) }, status);
  }

  if (body.action === "resend-verification") {
    const email = clean(body.email).toLowerCase();
    if (!validEmail(email)) {
      return json({ error: "Valid email is required" }, 400);
    }

    const genericResponse = () =>
      json({
        ok: true,
        message:
          "If a pending unverified host application uses this email, a new verification link will arrive shortly.",
      });
    const { data: app, error: appError } = await db
      .from("open_play_host_applications")
      .select(
        "id, host_user_id, full_name, email, status, verification_email_sent_at, verification_email_resend_count",
      )
      .eq("email", email)
      .eq("status", "pending")
      .maybeSingle();
    if (appError) {
      console.error(
        "host verification resend lookup failed:",
        errMsg(appError),
      );
      return json({
        error: "Host verification service is temporarily unavailable",
      }, 503);
    }
    if (!app?.id || !app.host_user_id) return genericResponse();

    const previousSentAt = clean(app.verification_email_sent_at);
    const previousSentMs = Date.parse(previousSentAt);
    const resendCount = Math.max(
      0,
      Number(app.verification_email_resend_count || 0),
    );
    if (
      resendCount >= 10 ||
      (Number.isFinite(previousSentMs) &&
        Date.now() - previousSentMs < 5 * 60 * 1000)
    ) {
      return genericResponse();
    }

    const { data: authLookup, error: authLookupError } = await db.auth.admin
      .getUserById(clean(app.host_user_id));
    const authUser = authLookup?.user;
    if (
      authLookupError || !authUser ||
      normalizedEmail(authUser.email) !== email ||
      authUser.email_confirmed_at
    ) {
      return genericResponse();
    }

    const claimTime = new Date().toISOString();
    let claimQuery = db
      .from("open_play_host_applications")
      .update({
        verification_email_sent_at: claimTime,
        verification_email_resend_count: resendCount + 1,
      })
      .eq("id", app.id)
      .eq("status", "pending")
      .eq("verification_email_resend_count", resendCount);
    claimQuery = previousSentAt
      ? claimQuery.eq("verification_email_sent_at", previousSentAt)
      : claimQuery.is("verification_email_sent_at", null);
    const { data: claimed, error: claimError } = await claimQuery
      .select("id")
      .maybeSingle();
    if (claimError) {
      console.error(
        "host verification resend claim failed:",
        errMsg(claimError),
      );
      return json({
        error: "Host verification service is temporarily unavailable",
      }, 503);
    }
    if (!claimed) return genericResponse();

    try {
      const { data: linkData, error: linkError } = await db.auth.admin
        .generateLink({
          type: "magiclink",
          email,
          options: { redirectTo: hostVerificationRedirectUrl() },
        });
      const verificationUrl = clean(linkData?.properties?.action_link);
      if (linkError || !verificationUrl) {
        throw new Error(
          `Could not create a new verification link: ${errMsg(linkError)}`,
        );
      }
      await deliverHostVerificationEmail(
        email,
        clean(app.full_name) || "Host applicant",
        verificationUrl,
        "host_email_verification_resend",
      );
      return genericResponse();
    } catch (error) {
      const { error: releaseError } = await db
        .from("open_play_host_applications")
        .update({
          verification_email_sent_at: previousSentAt || null,
          verification_email_resend_count: resendCount,
        })
        .eq("id", app.id)
        .eq("verification_email_resend_count", resendCount + 1);
      console.error(
        "host verification resend failed:",
        errMsg(error),
        releaseError ? `claim release: ${errMsg(releaseError)}` : "",
      );
      return json({
        error:
          "Could not resend the verification email. Please try again later.",
      }, 503);
    }
  }

  if (body.action === "sign-valid-id") {
    const reviewer = await requireReviewer(req, db);
    if ("error" in reviewer) return reviewer.error;

    const applicationId = clean(body.applicationId);
    if (!applicationId) {
      return json({ error: "Application id is required" }, 400);
    }

    const { data: app, error: appErr } = await db
      .from("open_play_host_applications")
      .select("valid_id_path")
      .eq("id", applicationId)
      .single();
    if (appErr || !app?.valid_id_path) {
      return json({ error: "No valid ID available" }, 404);
    }

    const { data, error } = await db.storage.from("host-ids").createSignedUrl(
      app.valid_id_path,
      300,
    );
    if (error || !data?.signedUrl) {
      return json({ error: errMsg(error) || "Could not sign valid ID" }, 500);
    }
    return json({ ok: true, url: data.signedUrl });
  }

  if (body.action === "repair-activation") {
    const reviewer = await requireReviewer(req, db);
    if ("error" in reviewer) return reviewer.error;

    const applicationId = clean(body.applicationId);
    if (!applicationId) {
      return json({ error: "Application id is required" }, 400);
    }
    try {
      const loaded = await loadHostApplication(db, applicationId);
      if (clean(loaded.app.status) !== "approved") {
        return json(
          { error: "Only an approved application can be repaired" },
          409,
        );
      }
      const rawReviewNote = clean(loaded.app.review_note);
      const reviewNote = loaded.meta.reviewNote ||
        (rawReviewNote.startsWith("{") ? "" : rawReviewNote) ||
        "Approved for 25% host booking access.";
      const activated = await activateHostApplication(db, loaded, {
        reviewerId: reviewer.user.id,
        reviewNote,
        markApproved: false,
      });
      return json({
        ok: true,
        status: "approved",
        loginLinked: true,
        hostUserId: activated.hostUserId,
        accountStatus: activated.accountStatus,
      });
    } catch (error) {
      const status = error instanceof HostActivationError ? error.status : 500;
      return json({ error: errMsg(error) }, status);
    }
  }

  if (body.action === "review") {
    const reviewer = await requireReviewer(req, db);
    if ("error" in reviewer) return reviewer.error;

    const applicationId = clean(body.applicationId);
    const status = body.status === "approved"
      ? "approved"
      : body.status === "rejected"
      ? "rejected"
      : "";
    if (!applicationId || !status) {
      return json(
        { error: "Application id and review status are required" },
        400,
      );
    }

    let loaded: LoadedHostApplication;
    try {
      loaded = await loadHostApplication(db, applicationId);
    } catch (error) {
      const errorStatus = error instanceof HostActivationError
        ? error.status
        : 500;
      return json({ error: errMsg(error) }, errorStatus);
    }
    const { app, legacySchema, meta } = loaded;
    const hostUserId = app.host_user_id || meta.hostUserId;
    const appFullName = clean(app.full_name);
    const reviewNote = clean(body.reviewNote) ||
      (status === "approved"
        ? "Approved for 25% host booking access."
        : "Application rejected.");

    if (status === "approved") {
      try {
        const activated = await activateHostApplication(db, loaded, {
          reviewerId: reviewer.user.id,
          reviewNote,
          markApproved: true,
        });
        const decisionEmailSent = await deliverHostDecisionEmail(
          app,
          "approved",
          reviewNote,
        );
        return json({
          ok: true,
          status: "approved",
          loginLinked: true,
          hostUserId: activated.hostUserId,
          accountStatus: activated.accountStatus,
          decisionEmailSent,
        });
      } catch (error) {
        const errorStatus = error instanceof HostActivationError
          ? error.status
          : 500;
        return json({ error: errMsg(error) }, errorStatus);
      }
    }

    // Rejection keeps the existing fail-closed order: suspend access before
    // recording the application as rejected.
    if (typeof hostUserId === "string" && hostUserId) {
      const { data: authLookup, error: authLookupErr } = await db.auth.admin
        .getUserById(hostUserId);
      if (authLookupErr || !authLookup?.user) {
        return json({
          error: `Linked host auth account was not found: ${
            errMsg(authLookupErr)
          }`,
        }, 409);
      }

      const appEmail = normalizedEmail(app.email);
      if (normalizedEmail(authLookup.user.email) !== appEmail) {
        return json({
          error: "Linked Auth account email does not match the application",
        }, 409);
      }
      const currentMetadata = authLookup.user.user_metadata &&
          typeof authLookup.user.user_metadata === "object"
        ? authLookup.user.user_metadata
        : {};
      const currentMetadataRole = clean(currentMetadata.role);
      const currentAppRole = authLookup.user.app_metadata &&
          typeof authLookup.user.app_metadata === "object"
        ? clean(authLookup.user.app_metadata.role)
        : "";
      if (
        (currentMetadataRole && currentMetadataRole !== "host") ||
        (currentAppRole && !["authenticated", "host"].includes(currentAppRole))
      ) {
        return json({
          error: "Linked Auth login belongs to a non-host identity",
        }, 409);
      }

      let existingAccount: ExistingAccount | null;
      try {
        existingAccount = await safeExistingHostAccount(
          db,
          hostUserId,
          appEmail,
        );
      } catch (error) {
        const errorStatus = error instanceof HostActivationError
          ? error.status
          : 500;
        return json({ error: errMsg(error) }, errorStatus);
      }

      // Suspend the accounts row first because database authorization checks
      // it on every request, including sessions whose JWT is already issued.
      if (existingAccount) {
        const { data: suspendedAccount, error: accountErr } = await db
          .from("accounts")
          .update({ status: "suspended" })
          .eq("id", hostUserId)
          .select("id")
          .maybeSingle();
        if (accountErr || !suspendedAccount) {
          return json({
            error: `Could not suspend host account: ${errMsg(accountErr)}`,
          }, 500);
        }
      }

      const { error: authErr } = await db.auth.admin.updateUserById(
        hostUserId,
        {
          user_metadata: {
            ...currentMetadata,
            full_name: appFullName,
            role: "host",
            account_status: "suspended",
          },
        },
      );
      if (authErr) {
        return json({
          error: `Could not suspend host login: ${errMsg(authErr)}`,
        }, 500);
      }
    }

    const storedReviewNote =
      legacySchema && typeof hostUserId === "string" && hostUserId
        ? signupMeta(hostUserId, meta.gcashNumber, reviewNote)
        : reviewNote;
    const applicationUpdates: Record<string, unknown> = {
      status,
      review_note: storedReviewNote,
      reviewed_by: reviewer.user.id,
      reviewed_at: new Date().toISOString(),
    };
    // Applications submitted against the pre-migration schema kept their auth
    // id in review_note. Once the modern columns exist, persist that id in its
    // proper column so later rejection/reactivation still targets the login.
    if (
      !legacySchema && !app.host_user_id && typeof hostUserId === "string" &&
      hostUserId
    ) {
      applicationUpdates.host_user_id = hostUserId;
      if (meta.gcashNumber) applicationUpdates.gcash_number = meta.gcashNumber;
    }
    const { data: updatedApp, error: updErr } = await db
      .from("open_play_host_applications")
      .update(applicationUpdates)
      .eq("id", applicationId)
      .select("id")
      .maybeSingle();
    if (updErr) return json({ error: errMsg(updErr) }, 500);
    if (!updatedApp) return json({ error: "Host application not found" }, 404);

    const decisionEmailSent = await deliverHostDecisionEmail(
      app,
      "rejected",
      reviewNote,
    );
    return json({
      ok: true,
      status,
      loginLinked: typeof hostUserId === "string" && Boolean(hostUserId),
      hostUserId: typeof hostUserId === "string" && hostUserId
        ? hostUserId
        : null,
      accountStatus: typeof hostUserId === "string" && hostUserId
        ? "suspended"
        : null,
      decisionEmailSent,
    });
  }

  if (body.action !== "signup") return json({ error: "Unknown action" }, 400);

  const fullName = clean(body.fullName);
  const contactNumber = clean(body.contactNumber);
  const email = clean(body.email).toLowerCase();
  const password = String(body.password || "");
  const gcashNumber = clean(body.gcashNumber);
  const validIdBase64 = String(body.validIdBase64 || "");
  const validIdFileName = clean(body.validIdFileName);
  const validIdFileType = clean(body.validIdFileType);
  const validIdFileSize = Number(body.validIdFileSize || 0);
  const notes = clean(body.notes);
  const preferredSchedule = clean(body.preferredSchedule);

  if (fullName.length < 3 || fullName.length > 150) {
    return json({ error: "Full name is required" }, 400);
  }
  if (!validPhone(contactNumber)) {
    return json({ error: "Valid phone number is required" }, 400);
  }
  if (!validEmail(email)) {
    return json({ error: "Valid email is required" }, 400);
  }
  if (notes.length > 2000 || preferredSchedule.length > 200) {
    return json({ error: "Host application text is too long" }, 400);
  }

  const hasValidId = Boolean(
    validIdBase64 || validIdFileName || validIdFileType || validIdFileSize,
  );
  if (password.length < 8) {
    return json({ error: "Password must be at least 8 characters" }, 400);
  }
  if (!validPhone(gcashNumber)) {
    return json({ error: "Valid GCash number is required" }, 400);
  }
  let idBytes: Uint8Array | null = null;
  if (hasValidId) {
    if (
      !validIdBase64 || !validIdFileName ||
      !ALLOWED_ID_TYPES.has(validIdFileType)
    ) {
      return json(
        { error: "Valid ID upload must be a JPG, PNG, WebP, or PDF" },
        400,
      );
    }
    if (validIdFileSize > MAX_ID_BYTES) {
      return json({ error: "Valid ID file must be 5MB or smaller" }, 400);
    }
    try {
      idBytes = base64ToBytes(validIdBase64);
    } catch {
      return json({ error: "Valid ID upload is not valid base64 data" }, 400);
    }
    if (idBytes.byteLength > MAX_ID_BYTES) {
      return json({ error: "Valid ID file must be 5MB or smaller" }, 400);
    }
  }

  let authUserId = "";
  let idPath: string | null = null;
  const applicationId = crypto.randomUUID();
  try {
    const usernameMatch = await restSelect("accounts", {
      username: `eq.${email}`,
    });
    const emailMatch = await restSelect("accounts", { email: `eq.${email}` });

    if (
      (usernameMatch && usernameMatch.length > 0) ||
      (emailMatch && emailMatch.length > 0)
    ) {
      return json({
        error: "A host account or application already uses this email",
      }, 409);
    }

    const existingApp = await restSelect("open_play_host_applications", {
      email: `eq.${email}`,
      status: "neq.rejected",
    });
    if (existingApp && existingApp.length > 0) {
      return json({
        error: "A pending host application already uses this email",
      }, 409);
    }

    const existingAuthUsers = await authUsersByExactEmail(db, email);
    if (existingAuthUsers.length > 0) {
      return json({
        error:
          "An Auth login already uses this email. Use verification resend for a pending application or contact support.",
      }, 409);
    }

    authUserId = await createAuthUser(email, password, fullName);

    if (idBytes) {
      idPath = `${authUserId}/${crypto.randomUUID()}.${
        safeExt(validIdFileName, validIdFileType)
      }`;
      const { error: uploadErr } = await db.storage.from("host-ids").upload(
        idPath,
        idBytes,
        {
          contentType: validIdFileType,
          upsert: false,
        },
      );
      if (uploadErr) throw uploadErr;
    }

    const app = await restInsert("open_play_host_applications", {
      id: applicationId,
      host_user_id: authUserId,
      full_name: fullName,
      contact_number: contactNumber,
      email,
      gcash_number: gcashNumber,
      valid_id_file_name: idBytes ? validIdFileName : null,
      valid_id_file_type: idBytes ? validIdFileType : null,
      valid_id_file_size: idBytes ? idBytes.byteLength : null,
      valid_id_path: idPath,
      preferred_schedule: preferredSchedule || null,
      notes: notes || null,
      review_note: signupMeta(authUserId, gcashNumber),
      status: "pending",
      verification_email_sent_at: new Date().toISOString(),
      verification_email_resend_count: 0,
      created_at: new Date().toISOString(),
    });

    return json({
      ok: true,
      applicationId: typeof app.id === "string" ? app.id : "",
      emailVerificationSent: true,
    });
  } catch (err) {
    if (idPath) {
      const { error: removeError } = await db.storage.from("host-ids").remove([
        idPath,
      ]);
      if (removeError) {
        console.error("host ID cleanup failed:", errMsg(removeError));
      }
    }
    if (authUserId) {
      const cleanupError = await deleteAuthUser(authUserId);
      if (cleanupError) {
        console.error("host Auth cleanup failed:", cleanupError);
        return json({
          error:
            "Host application failed and account cleanup needs administrator review. Please contact support before retrying.",
        }, 500);
      }
    }
    return json({ error: errMsg(err) }, 500);
  }
});

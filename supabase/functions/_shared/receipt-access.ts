const DASHBOARD_RECEIPT_ROLES = new Set([
  "owner",
  "court_owner",
  "staff",
]);

export type ReceiptAccount =
  | {
    role?: unknown;
    status?: unknown;
  }
  | null
  | undefined;

export type BookingReceiptOwner = {
  host_booking?: unknown;
  host_user_id?: unknown;
  created_by_user_id?: unknown;
};

export type HostSessionReceiptOwner = {
  host_user_id?: unknown;
};

function normalizedId(value: unknown): string {
  return String(value || "").trim();
}

export function activeReceiptRole(account: ReceiptAccount): string {
  if (String(account?.status || "").toLowerCase() !== "active") return "";
  return String(account?.role || "").toLowerCase();
}

export function canViewDashboardReceipt(account: ReceiptAccount): boolean {
  return DASHBOARD_RECEIPT_ROLES.has(activeReceiptRole(account));
}

export function canViewBookingReceipt(
  account: ReceiptAccount,
  userId: unknown,
  booking: BookingReceiptOwner | null | undefined,
): boolean {
  if (canViewDashboardReceipt(account)) return true;
  const id = normalizedId(userId);
  if (
    !id || activeReceiptRole(account) !== "host" ||
    booking?.host_booking !== true
  ) {
    return false;
  }
  return normalizedId(booking.host_user_id) === id ||
    normalizedId(booking.created_by_user_id) === id;
}

export function canViewHostSessionReceipt(
  account: ReceiptAccount,
  userId: unknown,
  session: HostSessionReceiptOwner | null | undefined,
): boolean {
  if (canViewDashboardReceipt(account)) return true;
  const id = normalizedId(userId);
  return !!id && activeReceiptRole(account) === "host" &&
    normalizedId(session?.host_user_id) === id;
}

export function isBookingAccessToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export async function sha256TextHex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function bookingAccessTokenMatches(
  token: unknown,
  expectedHash: unknown,
): Promise<boolean> {
  if (!isBookingAccessToken(token)) return false;
  const normalizedHash = String(expectedHash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedHash)) return false;
  const actualHash = await sha256TextHex(token);
  return constantTimeHexEqual(actualHash, normalizedHash);
}

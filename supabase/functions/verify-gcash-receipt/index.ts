// verify-gcash-receipt
// ----------------------------------------------------------------------------
// Server-side GCash / BDO Pay / GoTyme / PNB receipt verification + fraud detection.
//
// Actions (POST JSON):
//   multipart { action: "verify", bookingRef, provider, receipt, contentType }
//   JSON { action: "verify", bookingRef, provider, imageBase64, contentType }
//     -> OCR (Google Vision) + fraud checks + confidence routing.
//        Stores the image (private bucket), writes an audit row, advances
//        payment_status on auto-approve, and alerts admin on review/reject.
//   { action: "sign", bookingRef }    (admin-only, requires a user JWT)
//     -> returns a short-lived signed URL to view the stored receipt image.
//
// Decision lanes:
//   auto_approved : a persisted GCash booking passes every dedicated check
//   manual_review : any uncertain or mismatched GCash evidence
//   rejected      : a proven reused GCash reference, or legacy provider hard flag
//
// A GCash manual-review result always keeps the booking pending and its slot
// held. Only a payment reference already claimed by another booking is allowed
// to cancel a GCash booking automatically.
// ----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  calculateCourtPayment,
  chooseExpectedDue,
  classifyStoredSessionPayment,
  closeMoney,
  roundMoney,
  toNumber,
} from "../_shared/booking-payment.ts";
import {
  compareGcashRecipient,
  type GcashReceiptParse,
  type GcashRecipientComparison,
  parseGcashReceipt,
} from "../_shared/gcash-receipt.ts";
import {
  detectReceiptImageContentType,
  googleVisionOcr,
  type ReceiptImageContentType,
  receiptImageSafeToDecode,
} from "../_shared/google-vision.ts";
import { extractReceiptAmount } from "../_shared/receipt-amount.ts";
import { isEmailAddress, sendMailerooEmail } from "../_shared/maileroo.ts";
import { renderBookingCancellationEmail } from "../_shared/paddle-rage-email.ts";
import {
  activeReceiptRole,
  bookingAccessTokenMatches,
  canViewBookingReceipt,
  canViewDashboardReceipt,
  canViewHostSessionReceipt,
  type ReceiptAccount,
} from "../_shared/receipt-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Payment must happen within this many minutes after the booking/session join
// is started.
// Keep this aligned with the customer-facing reservation countdown.
const PAYMENT_WINDOW_MINUTES = 15;
// OCR usually reads only minute-level timestamps. A receipt paid during the
// same minute as the hold can look a few seconds "before" the booking.
const PAYMENT_EARLY_TOLERANCE_MINUTES = 2;

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const PESO_TOLERANCE = 5; // allow ±₱5 rounding; underpay beyond this is a hard flag

// Hard flags force a rejection; soft flags force manual review.
const HARD_FLAGS = new Set([
  "REF_FORMAT_INVALID",
  "DUPLICATE_REF",
  "DUPLICATE_INVOICE",
  "DUPLICATE_INSTAPAY_REF",
  "DUPLICATE_BPI_TRANSACTION_REF",
  "METHOD_MISMATCH",
  "REF_MISMATCH",
  "DATE_NOT_TODAY",
  "TIME_EXPIRED",
  "TIME_FUTURE",
  "WRONG_GCASH_NUMBER",
  "AMOUNT_MISMATCH", // Only hard if significantly underpaid (>₱5)
]);

type PaymentProvider = "gcash" | "bdopay" | "maya" | "bpi" | "gotyme" | "pnb";
type OcrProvider = "google_vision" | "none";

type OcrResult = {
  text: string;
  confidence: number;
  confidenceSource: "native" | "heuristic" | "none";
  provider: OcrProvider;
  primaryProvider?: OcrProvider;
  fallbackProvider?: OcrProvider;
  fallbackReason?: string;
  error?: string;
};

type ReceiptCaller = {
  userId: string;
  account: ReceiptAccount;
};

type BookingMutationScope = {
  customerAccessTokenHash?: string;
  hostUserId?: string;
};

function publicReceiptMessage(
  result: "auto_approved" | "manual_review" | "rejected",
  flags: string[],
): string {
  if (result === "auto_approved") return "Payment verified.";
  if (result === "manual_review") {
    return "Received - the owner will verify your payment shortly.";
  }

  const flagSet = new Set(flags);
  if (flagSet.has("AMOUNT_MISMATCH")) {
    return "Payment amount is lower than required. Please upload the correct payment receipt.";
  }
  if (
    flagSet.has("TIME_EXPIRED") || flagSet.has("TIME_FUTURE") ||
    flagSet.has("DATE_NOT_TODAY")
  ) {
    return `Payment was sent outside the allowed ${PAYMENT_WINDOW_MINUTES}-minute window. Please create a new booking.`;
  }
  if (flagSet.has("IMAGE_UNREADABLE") || flagSet.has("OCR_UNAVAILABLE")) {
    return "Receipt image is unreadable. Please upload a clearer screenshot.";
  }
  if (
    flagSet.has("SUSPECTED_FAKE") ||
    flagSet.has("GCASH_RECEIPT_UNREADABLE") ||
    flagSet.has("BDO_PAY_UNREADABLE") ||
    flagSet.has("MAYA_UNREADABLE") ||
    flagSet.has("BPI_UNREADABLE")
  ) {
    return "Payment could not be verified. Please upload a valid receipt or contact admin.";
  }
  return "Payment details do not match this booking. Please check your receipt and try again, or contact admin.";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const m = err as Record<string, unknown>;
    if (typeof m.message === "string") return m.message;
    if (typeof m.error === "string") return m.error;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function base64ToBytes(b64: string): Uint8Array {
  // Accept raw base64 or a data: URL.
  const comma = b64.indexOf(",");
  const raw = b64.startsWith("data:") && comma !== -1
    ? b64.slice(comma + 1)
    : b64;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Build the binary string in chunks so a mobile-upload-sized image does not
  // exceed the JavaScript argument/call-stack limit.
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copy.buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Difference-hash (dHash): 64-bit perceptual hash robust to recompression and
// light cropping/scaling. Returns 16-hex-char string, or null if undecodable.
async function dHash(
  bytes: Uint8Array,
  contentType: ReceiptImageContentType,
): Promise<string | null> {
  // ImageScript expands pixels in Edge memory. Skip perceptual hashing when a
  // compressed image declares unsafe dimensions; exact SHA-256 and OCR still
  // provide the audit/detection signals without risking decompression OOM.
  if (!receiptImageSafeToDecode(bytes, contentType)) return null;
  try {
    const img = await Image.decode(bytes);
    const small = img.resize(9, 8); // 9x8 -> 8 horizontal comparisons per row
    let bits = "";
    for (let y = 1; y <= 8; y++) {
      for (let x = 1; x <= 8; x++) {
        const lPix = small.getPixelAt(x, y);
        const rPix = small.getPixelAt(x + 1, y);
        const lGray = ((lPix >>> 24) & 0xff) + ((lPix >>> 16) & 0xff) +
          ((lPix >>> 8) & 0xff);
        const rGray = ((rPix >>> 24) & 0xff) + ((rPix >>> 16) & 0xff) +
          ((rPix >>> 8) & 0xff);
        bits += lGray < rGray ? "1" : "0";
      }
    }
    let hex = "";
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null; // HEIC/unknown formats — skip perceptual dedupe, not fatal
  }
}

function phManilaNow(): Date {
  // Current instant shifted to UTC+8 wall clock.
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function phTodayStr(): string {
  return phManilaNow().toISOString().slice(0, 10); // YYYY-MM-DD in PH
}

function toPhWallClockDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000);
}

function formatPhDateTime12(d: Date | null): string | null {
  if (!d) return null;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  let hour = d.getUTCHours();
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  const ampm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${year}-${month}-${day} ${hour}:${minute} ${ampm} PH`;
}

function formatPhInstantDateTime12(d: Date | null): string | null {
  if (!d) return null;
  return formatPhDateTime12(toPhWallClockDate(d.toISOString()));
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Parse a GCash-style timestamp e.g. "Jun 13, 2026 10:30 AM" into a Date
// interpreted as PH wall-clock (returned as a UTC+8-shifted Date for comparison
// against phManilaNow()). If OCR only finds the date, return the date but no
// shifted time so it routes to manual review instead of assuming midnight.
function parseReceiptDateTime(
  text: string,
): { date: string | null; shifted: Date | null } {
  const normalized = String(text || "")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const datePattern =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?[\s,.\-]+(\d{4})\b/i;
  const dateOnly = normalized.match(datePattern);
  if (!dateOnly) return { date: null, shifted: null };

  const mon = MONTHS[dateOnly[1].toLowerCase().slice(0, 3)];
  const day = parseInt(dateOnly[2], 10);
  const year = parseInt(dateOnly[3], 10);
  const dateStr = `${year}-${String(mon + 1).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;

  const afterDate = normalized.slice(
    (dateOnly.index || 0) + dateOnly[0].length,
    (dateOnly.index || 0) + dateOnly[0].length + 80,
  );
  const beforeDate = normalized.slice(
    Math.max(0, (dateOnly.index || 0) - 40),
    dateOnly.index || 0,
  );
  const timePattern =
    /\b(\d{1,2})\s*[:;.]\s*(\d{2})(?:\s*[:;.]\s*\d{2})?\s*([ap](?:\s*\.?\s*m\.?)?|[ap])\b/i;
  const time = afterDate.match(timePattern) || beforeDate.match(timePattern);
  if (time) {
    let hour = parseInt(time[1], 10);
    const min = parseInt(time[2], 10);
    const ap = time[3].toLowerCase().replace(/[^apm]/g, "");
    if (ap.startsWith("p") && hour !== 12) hour += 12;
    if (ap.startsWith("a") && hour === 12) hour = 0;
    const shifted = new Date(Date.UTC(year, mon, day, hour, min, 0));
    return { date: dateStr, shifted };
  }

  return { date: dateStr, shifted: null };
}

function digitsOnly(s: string): string {
  return (s || "").replace(/\D/g, "");
}

function normalizeReferenceForProvider(
  value: string,
  provider: PaymentProvider,
): string {
  const raw = value || "";
  if (provider === "gcash") return digitsOnly(raw);
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isBdoPayReference(value: string): boolean {
  return /^BN\d{16}$/.test(normalizeReferenceForProvider(value, "bdopay"));
}

function isMayaReference(value: string): boolean {
  return /^[A-Z0-9]{12}$/.test(normalizeReferenceForProvider(value, "maya"));
}

function isBpiConfirmationNo(value: string): boolean {
  return /^\d{10,20}$/.test(digitsOnly(value));
}

function flexibleDigitPattern(digits: string): RegExp {
  return new RegExp(digits.split("").join("[^0-9]*"));
}

// Extract candidate 13-digit GCash reference numbers from OCR text.
function extractGcashRef(text: string, typedRef = ""): string | null {
  const normalizedTyped = digitsOnly(typedRef);

  // If the customer-entered ref is visible in the OCR text, trust it. This
  // avoids false mismatches when OCR sees the receiver mobile number before the
  // "Ref No." line and a broad numeric scan accidentally joins nearby digits.
  if (
    normalizedTyped.length === 13 &&
    flexibleDigitPattern(normalizedTyped).test(text)
  ) {
    return normalizedTyped;
  }

  // Prefer numbers immediately following receipt reference labels.
  const labelPattern =
    /\b(?:ref(?:erence)?(?:\s*(?:no|number|#))?\.?)\s*[:#]?\s*([0-9][0-9\s-]{11,30}[0-9])/gi;
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = labelPattern.exec(text)) !== null) {
    const d = digitsOnly(labelMatch[1]);
    if (d.length === 13) return d;
    if (normalizedTyped.length === 13 && d.includes(normalizedTyped)) {
      return normalizedTyped;
    }
  }

  // Fallback: any standalone 13-digit run.
  const standalone = text.match(/\b\d{13}\b/);
  if (standalone) return standalone[0];

  // Last resort: tolerate OCR spaces inside a single long numeric group.
  // Keep this after label/typed matching because phone numbers and amounts can
  // otherwise be accidentally joined into a fake 13-digit reference.
  const cleaned = text.replace(/[^\d\s-]/g, " ");
  const groups = cleaned.match(/(?:\d[\d\s-]{11,30}\d)/g) || [];
  for (const g of groups) {
    const d = digitsOnly(g);
    if (d.length === 13) return d;
  }
  return null;
}

function extractBpiConfirmationNo(text: string, typedRef = ""): string | null {
  const normalizedTyped = digitsOnly(typedRef);
  if (
    isBpiConfirmationNo(normalizedTyped) &&
    flexibleDigitPattern(normalizedTyped).test(text)
  ) {
    return normalizedTyped;
  }

  const patterns = [
    /\bconfirmation\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{8,24}[0-9])\b/i,
    /\bconfirm(?:ation)?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{8,24}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (isBpiConfirmationNo(ref)) return ref;
  }
  return null;
}

function extractReference(
  text: string,
  provider: PaymentProvider,
  typedRef: string,
): string | null {
  if (provider === "gcash") return extractGcashRef(text, typedRef);
  if (provider === "bpi") return extractBpiConfirmationNo(text, typedRef);

  // BDO Pay/GoTyme/PNB references are not guaranteed to be 13-digit GCash-style refs.
  // For those providers, trust the customer-entered reference only if OCR sees
  // the same alphanumeric token in the receipt text.
  const normalizedTyped = normalizeReferenceForProvider(typedRef, provider);
  if (normalizedTyped.length >= 6) {
    const normalizedText = normalizeReferenceForProvider(text, provider);
    if (normalizedText.includes(normalizedTyped)) return normalizedTyped;
  }
  return null;
}

function hasBdoPayIndicator(text: string): boolean {
  return isBdoPayReceipt(text);
}

function hasMayaIndicator(text: string): boolean {
  return isMayaReceipt(text);
}

function hasBpiIndicator(text: string): boolean {
  return isBpiReceipt(text);
}

function hasInstapayQrphIndicator(text: string): boolean {
  return /\binsta\s*pay\b|\bqrph\b|\bqr\s*ph\b/i.test(text);
}

function hasBdoBnReference(text: string): boolean {
  return /\bbn[\s-]*\d{8}[\s-]*\d{8}\b/i.test(text);
}

function isBdoPayReceipt(text: string): boolean {
  const t = text || "";
  const hasBnRef = hasBdoBnReference(t);
  return /\bbdo\s*pay\b/i.test(t) ||
    /\bthank\s+you\s+for\s+using\s+bdo\b/i.test(t) ||
    (hasBnRef && /\binsta\s*pay\b/i.test(t)) ||
    (hasBnRef && /\bbdo\b/i.test(t)) ||
    (hasBnRef && extractBdoInvoiceNumber(t) !== null);
}

function isMayaReceipt(text: string): boolean {
  const t = text || "";
  return /\bmaya\b/i.test(t) &&
    (/\bsent\s+money\s+via\b/i.test(t) ||
      /\breference\s+id\b/i.test(t) ||
      /\binstapay\s+ref\b/i.test(t) ||
      /\bqrph\b|\bqr\s*ph\b/i.test(t));
}

function isBpiReceipt(text: string): boolean {
  const t = text || "";
  return /\bsent\s+via\s+bpi\b/i.test(t) ||
    /\bbpi\b/i.test(t) ||
    (/\btransfer\s+successful\b/i.test(t) &&
      /\bconfirmation\s*(?:no|number|#)?\.?\b/i.test(t) &&
      /\binsta\s*pay\b/i.test(t));
}

function hasGcashGxiDestination(text: string): boolean {
  return /\bgcash\s*\/\s*g-?xchange\b/i.test(text) ||
    /\bg-?xchange\b/i.test(text) ||
    /\bgcash\b/i.test(text);
}

function isGcashToGcashReceipt(text: string): boolean {
  const t = text || "";
  if (isBdoPayReceipt(t) || isMayaReceipt(t) || isBpiReceipt(t)) return false;
  return /\bsent\s+via\s+gcash\b/i.test(t) ||
    /\bsent\s+through\s+gcash\b/i.test(t) ||
    /\bgcash\s+receipt\b/i.test(t) ||
    /\btotal\s+amount\s+sent\b/i.test(t);
}

function selectedMethodMismatch(
  provider: PaymentProvider,
  text: string,
): boolean {
  const bdoReceipt = isBdoPayReceipt(text);
  const mayaReceipt = isMayaReceipt(text);
  const bpiReceipt = isBpiReceipt(text);
  const gcashReceipt = isGcashToGcashReceipt(text);
  if (provider === "gcash") return bdoReceipt || mayaReceipt || bpiReceipt;
  if (provider === "bdopay") return gcashReceipt || mayaReceipt || bpiReceipt;
  if (provider === "maya") return gcashReceipt || bdoReceipt || bpiReceipt;
  if (provider === "bpi") return gcashReceipt || bdoReceipt || mayaReceipt;
  return false;
}

function hasExpectedReceiverName(text: string, expectedName: string): boolean {
  const upper = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const expected = (expectedName || "Paddle Rage Pickleball").toUpperCase()
    .replace(
      /[^A-Z0-9]/g,
      "",
    );
  if (expected.length >= 3 && upper.includes(expected)) return true;
  return upper.includes("PADDLERAGE");
}

function extractBdoInvoiceNumber(text: string): string | null {
  const patterns = [
    /\binvoice\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
    /\binv\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,24}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const invoice = match ? digitsOnly(match[1]) : "";
    if (invoice.length >= 4 && invoice.length <= 20) return invoice;
  }
  return null;
}

function extractMayaInstapayRefNo(text: string): string | null {
  const patterns = [
    /\binstapay\s*ref\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
    /\binstapay\s*(?:reference|ref)\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (ref.length >= 4 && ref.length <= 20) return ref;
  }
  return null;
}

function extractBpiTransactionRefNo(text: string): string | null {
  const patterns = [
    /\btransaction\s*ref\.?\s*(?:no|number|#)?\.?\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
    /\btransaction\s*(?:reference|ref)\s*[:#]?\s*([0-9][0-9\s-]{3,20}[0-9])\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const ref = match ? digitsOnly(match[1]) : "";
    if (ref.length >= 4 && ref.length <= 20) return ref;
  }
  return null;
}

function extractAmount(text: string): number | null {
  // Legacy parser for non-Maya layouts. Require a complete money token so a
  // value such as P1,080.00 can never fall through as the suffix ,080.00.
  const near = text.match(
    /(?:amount|total|php|₱|p)\s*[:\-]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d,.])/i,
  );
  if (near) return parseFloat(near[1].replace(/,/g, ""));
  const any = text.match(
    /(?<![A-Za-z0-9,])((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?![\d,.])/,
  );
  return any ? parseFloat(any[1].replace(/,/g, "")) : null;
}

function normalizedProvider(raw: string): PaymentProvider {
  const provider = raw.toLowerCase();
  if (
    provider === "bdopay" || provider === "maya" || provider === "bpi" ||
    provider === "gotyme" || provider === "pnb"
  ) return provider;
  return "gcash";
}

function paymentMethodProvider(raw: unknown): PaymentProvider | null {
  const method = String(raw || "").toLowerCase();
  if (
    method === "gcash" || method === "bdopay" || method === "maya" ||
    method === "bpi" || method === "gotyme" || method === "pnb"
  ) {
    return method as PaymentProvider;
  }
  return null;
}

function expectedMerchantForProvider(
  settings: Record<string, string>,
  provider: PaymentProvider,
): { number: string; name: string } {
  if (provider === "bdopay") {
    return {
      number: settings.bdopay_merchant_number ||
        settings.gcash_merchant_number || "",
      name: settings.bdopay_merchant_name || settings.payment_merchant_name ||
        settings.gcash_merchant_name || "",
    };
  }
  if (provider === "maya") {
    return {
      number: settings.maya_merchant_number || settings.gcash_merchant_number ||
        "",
      name: settings.maya_merchant_name || settings.payment_merchant_name ||
        settings.gcash_merchant_name || "",
    };
  }
  if (provider === "bpi") {
    return {
      number: settings.bpi_merchant_number || settings.gcash_merchant_number ||
        "",
      name: settings.bpi_merchant_name || settings.payment_merchant_name ||
        settings.gcash_merchant_name || "",
    };
  }
  if (provider === "gotyme") {
    return {
      number: settings.gotyme_merchant_number || "",
      name: settings.gotyme_merchant_name || "",
    };
  }
  if (provider === "pnb") {
    return {
      number: settings.pnb_merchant_number || "",
      name: settings.pnb_merchant_name || "",
    };
  }
  return {
    number: settings.gcash_merchant_number || "",
    name: settings.gcash_merchant_name || "",
  };
}

function expectedOpenPlayAmounts(
  booking: Record<string, unknown>,
  settings: Record<string, string>,
): { total: number; due: number } {
  const cfg = (() => {
    try {
      return settings.open_play_config
        ? JSON.parse(settings.open_play_config)
        : {};
    } catch {
      return {};
    }
  })() as Record<string, unknown>;
  const openPlayFee = toNumber(cfg.fee ?? settings.open_play_fee, 100);
  const platformFee = toNumber(
    settings.maintenance_fee ?? settings.service_fee_rate ??
      settings.booking_fee,
  );
  const total = roundMoney(openPlayFee + platformFee);
  const due = chooseExpectedDue(
    total,
    toNumber(booking.downpayment, -1),
    settings.payment_acceptance_mode,
  );
  return { total, due };
}

async function expectedHostSessionAmounts(
  db: any,
  booking: Record<string, unknown>,
): Promise<{ total: number; due: number }> {
  const sessionId = String(booking.host_session_id || "");
  if (!sessionId) throw new Error("Host session id is required");
  const { data: session, error } = await db
    .from("open_play_host_sessions")
    .select("fee_per_player")
    .eq("id", sessionId)
    .single();
  if (error || !session) throw error || new Error("Host session not found");

  const total = roundMoney(toNumber(session.fee_per_player));
  if (!closeMoney(toNumber(booking.downpayment, -1), total)) {
    throw new Error(
      "Host session payment amount does not match the configured fee",
    );
  }
  return { total, due: total };
}

async function expectedBookingAmounts(
  db: any,
  booking: Record<string, unknown>,
  settings: Record<string, string>,
): Promise<{ total: number; due: number }> {
  const courtId = String(booking.court_id || "");
  if (!courtId) return expectedOpenPlayAmounts(booking, settings);

  const { data: court, error: courtErr } = await db
    .from("courts")
    .select("rate,rate_schedule")
    .eq("id", courtId)
    .single();
  if (courtErr || !court) throw courtErr || new Error("Court not found");

  const courtRow = court as Record<string, unknown>;
  return calculateCourtPayment({
    slots: booking.slots,
    courtRate: courtRow.rate,
    courtRateSchedule: courtRow.rate_schedule,
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
  booking: Record<string, unknown>,
  scope: BookingMutationScope,
): Promise<Array<Record<string, unknown>>> {
  const groupRef = String(booking.booking_group_ref || "");
  if (!groupRef) return [booking];
  let query = db
    .from("bookings")
    .select(
      "ref, booking_group_ref, court_id, court_name, slots, total, downpayment, host_booking, gcash_ref, payment_method, date, start_time, end_time, payment_status, status, full_name, created_at",
    )
    .eq("booking_group_ref", groupRef);
  if (scope.customerAccessTokenHash) {
    query = query.eq(
      "customer_access_token_hash",
      scope.customerAccessTokenHash,
    );
  } else if (scope.hostUserId) {
    query = query.eq("host_user_id", scope.hostUserId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as Array<Record<string, unknown>>;
}

function bookingLogicalKey(row: Record<string, unknown>): string {
  const slots = Array.isArray(row.slots)
    ? row.slots.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  return [
    String(row.court_id || row.courtId || ""),
    String(row.date || ""),
    slots.join(","),
  ].join("|");
}

function uniqueBookingRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = bookingLogicalKey(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function expectedBookingGroupAmounts(
  db: any,
  bookings: Array<Record<string, unknown>>,
  settings: Record<string, string>,
): Promise<{ total: number; due: number }> {
  let total = 0;
  let due = 0;
  for (const row of uniqueBookingRows(bookings)) {
    const amounts = await expectedBookingAmounts(db, row, settings);
    total += amounts.total;
    due += amounts.due;
  }
  return { total: roundMoney(total), due: roundMoney(due) };
}

function bookingUpdateQuery(
  db: any,
  booking: Record<string, unknown>,
  update: Record<string, unknown>,
  scope: BookingMutationScope,
) {
  const groupRef = String(booking.booking_group_ref || "");
  let query = db.from("bookings").update(update);
  query = groupRef
    ? query.eq("booking_group_ref", groupRef)
    : query.eq("ref", String(booking.ref || ""));
  if (scope.customerAccessTokenHash) {
    query = query.eq(
      "customer_access_token_hash",
      scope.customerAccessTokenHash,
    );
  } else if (scope.hostUserId) {
    query = query.eq("host_user_id", scope.hostUserId);
  }
  return query;
}

// Best-effort "looks like a real GCash receipt" heuristic (soft signal only).
function looksLikeGcashReceipt(text: string): boolean {
  const t = text.toLowerCase();
  let score = 0;
  if (/ref(?:erence)?\s*(no|number|#)/.test(t)) score++;
  if (
    /gcash|bdo\s*pay|gotyme|maya|bpi|paymongo|qrph|insta\s*pay|pesonet|g-?xchange|gxi/
      .test(t)
  ) score++;
  if (
    /sent|received|paid|transfer|amount|confirmation\s*(no|number|#)/.test(t)
  ) score++;
  if (/\d{4}/.test(t)) score++;
  return score >= 2;
}

// Best-effort JPEG "edited in image software" detector (soft signal only).
function editedBySoftware(bytes: Uint8Array): boolean {
  // Scan the first 64KB for editor signatures embedded in EXIF/XMP.
  const slice = bytes.subarray(0, Math.min(bytes.length, 65536));
  let s = "";
  for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
  return /(adobe\s*photoshop|gimp|pixlr|snapseed|picsart|lightroom|inkscape)/i
    .test(s);
}

// Google Vision is the only OCR engine used for receipt verification.
function ocrCriticalGaps(
  text: string,
  provider: PaymentProvider,
  typedRef: string,
): string[] {
  if (!text) return ["text"];
  if (provider === "gcash") {
    const parsed = parseGcashReceipt(text, { typedReference: typedRef });
    const gaps: string[] = [];
    if (
      !parsed.reference.value ||
      parsed.reference.source !== "ref_label" ||
      parsed.reference.typedMatch !== "match"
    ) gaps.push("reference");
    if (
      parsed.amount.amount == null || !parsed.amount.reliable ||
      parsed.amount.ambiguous || parsed.amount.conflictingPrimaryAmounts
    ) gaps.push("amount");
    if (parsed.timestamp.completeness !== "date_time") gaps.push("date");
    return gaps;
  }
  const gaps: string[] = [];
  if (!extractReference(text, provider, typedRef)) gaps.push("reference");
  const mayaAmount = provider === "maya"
    ? extractReceiptAmount(text, { provider })
    : null;
  const hasReliableAmount = mayaAmount
    ? mayaAmount.amount != null && mayaAmount.reliable
    : extractAmount(text) != null;
  if (!hasReliableAmount) gaps.push("amount");
  if (!parseReceiptDateTime(text).date) gaps.push("date");
  return gaps;
}

async function runOCR(
  visionKey: string,
  base64: string,
  provider: PaymentProvider,
  typedRef: string,
): Promise<OcrResult> {
  if (visionKey) {
    try {
      const v = await googleVisionOcr(visionKey, base64);
      const gaps = ocrCriticalGaps(v.text, provider, typedRef);
      if (v.text && gaps.length === 0) {
        return {
          ...v,
          provider: "google_vision",
          primaryProvider: "google_vision",
        };
      }
      if (v.text) {
        return {
          ...v,
          provider: "google_vision",
          primaryProvider: "google_vision",
          fallbackReason: gaps.length
            ? `google_missing_${gaps.join("_")}`
            : undefined,
        };
      }
      console.error("Vision OCR returned no text:", gaps.join(","));
      return {
        ...v,
        provider: "google_vision",
        primaryProvider: "google_vision",
      };
    } catch (e) {
      console.error("Vision OCR failed:", errMsg(e));
      return {
        text: "",
        confidence: 0,
        confidenceSource: "none",
        provider: "none",
        primaryProvider: "google_vision",
        error: errMsg(e),
      };
    }
  }
  return {
    text: "",
    confidence: 0,
    confidenceSource: "none",
    provider: "none",
  };
}

function telegramAdminUrl(): string {
  return Deno.env.get("APP_ADMIN_URL") ||
    "https://paddleragecdo.ph/admin.html";
}

function shortTelegramFlags(flags: string[]): string {
  const shown = flags.slice(0, 2);
  const remaining = Math.max(0, flags.length - shown.length);
  return `${shown.join(", ") || "REVIEW_REQUIRED"}${
    remaining ? ` +${remaining}` : ""
  }`;
}

function telegramPeso(value: unknown): string {
  return `₱${
    Number(value || 0).toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
}

function telegramDate(value: unknown): string {
  const raw = String(value || "").slice(0, 10);
  const date = new Date(`${raw}T00:00:00+08:00`);
  if (!raw || Number.isNaN(date.getTime())) return raw || "—";
  return date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Manila",
  });
}

function telegramDateTime(value: unknown): string {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Manila",
  });
  const timePart = date.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  });
  return `${datePart} · ${timePart}`;
}

function telegramTimeMinutes(value: unknown): number | null {
  const match = String(value || "").trim().match(
    /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i,
  );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = String(match[3] || "").toUpperCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23)) return null;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (meridiem === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

function telegramCourtHours(row: Record<string, unknown>): number {
  if (Array.isArray(row.slots) && row.slots.length) return row.slots.length;
  const start = telegramTimeMinutes(row.start_time);
  const end = telegramTimeMinutes(row.end_time);
  if (start == null || end == null) return 0;
  return Math.max(0, (end - start) / 60);
}

function telegramHours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

async function sendTelegram(message: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  const chatIdRaw = Deno.env.get("TELEGRAM_CHAT_ID") || "";
  if (!botToken || !chatIdRaw) return;
  const chatIds = chatIdRaw.split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.allSettled(
    chatIds.map((chatId) =>
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        }),
      })
    ),
  );
}

// ── handler ─────────────────────────────────────────────────────────────────

async function loadReceiptCaller(
  req: Request,
  db: any,
): Promise<ReceiptCaller | null> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const { data: userData, error: userError } = await db.auth.getUser(token);
  const userId = String(userData?.user?.id || "");
  if (userError || !userId) return null;

  const { data: account, error: accountError } = await db
    .from("accounts")
    .select("role,status")
    .eq("id", userId)
    .maybeSingle();
  if (accountError) throw accountError;
  return { userId, account: account || null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ error: "Missing SERVICE_ROLE_KEY" }, 500);
  const db = createClient(supabaseUrl, serviceRoleKey);

  const requestLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(requestLength) && requestLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request too large" }, 413);
  }

  let body: Record<string, unknown>;
  let uploadedImage: File | null = null;
  const requestContentType = req.headers.get("content-type") || "";
  try {
    if (requestContentType.toLowerCase().includes("multipart/form-data")) {
      const form = await req.formData();
      const bookingDataRaw = String(form.get("bookingData") || "");
      let bookingData: Record<string, unknown> | null = null;
      if (bookingDataRaw) {
        try {
          const parsed = JSON.parse(bookingDataRaw);
          if (parsed && typeof parsed === "object") bookingData = parsed;
        } catch {
          return json({ error: "Invalid bookingData JSON" }, 400);
        }
      }
      const receipt = form.get("receipt");
      if (receipt instanceof File) uploadedImage = receipt;
      body = {
        action: String(form.get("action") || "verify"),
        bookingRef: String(form.get("bookingRef") || ""),
        bookingAccessToken: String(form.get("bookingAccessToken") || ""),
        provider: String(form.get("provider") || "gcash"),
        contentType: uploadedImage?.type ||
          String(form.get("contentType") || "image/jpeg"),
        ...(bookingData ? { bookingData } : {}),
      };
    } else {
      body = await req.json();
    }
  } catch {
    return json({
      error: requestContentType.toLowerCase().includes("multipart/form-data")
        ? "Invalid multipart body"
        : "Invalid JSON body",
    }, 400);
  }
  const action = (body.action as string) || "verify";

  // ── admin-only: mint a signed URL to view a stored receipt ────────────────
  if (action === "sign") {
    const bookingRef = String(body.bookingRef || "");
    const openPlayRegistrationId = String(body.openPlayRegistrationId || "");
    const hostSessionRegistrationId = String(
      body.hostSessionRegistrationId || "",
    );
    const targetCount = [
      bookingRef,
      openPlayRegistrationId,
      hostSessionRegistrationId,
    ].filter(Boolean).length;
    if (targetCount !== 1) {
      return json({
        error: "Exactly one receipt target is required",
      }, 400);
    }

    let caller: ReceiptCaller | null;
    try {
      caller = await loadReceiptCaller(req, db);
    } catch (error) {
      console.error("receipt caller lookup failed:", errMsg(error));
      return json({ error: "Receipt authorization could not be checked" }, 500);
    }
    if (!caller) return json({ error: "Unauthorized" }, 401);
    if (!activeReceiptRole(caller.account)) {
      return json(
        { error: "This account is not authorized to view receipts" },
        403,
      );
    }

    let path: string | null = null;
    if (hostSessionRegistrationId) {
      const { data: reg, error: regError } = await db
        .from("open_play_host_session_registrations")
        .select("receipt_image_url,session_id")
        .eq("id", hostSessionRegistrationId)
        .maybeSingle();
      if (regError) return json({ error: "Receipt could not be loaded" }, 500);
      if (!reg) return json({ error: "No receipt on file" }, 404);
      if (!canViewDashboardReceipt(caller.account)) {
        const { data: session, error: sessionError } = await db
          .from("open_play_host_sessions")
          .select("host_user_id")
          .eq("id", reg.session_id)
          .maybeSingle();
        if (sessionError) {
          return json(
            { error: "Receipt authorization could not be checked" },
            500,
          );
        }
        if (
          !canViewHostSessionReceipt(caller.account, caller.userId, session)
        ) {
          return json({ error: "Forbidden" }, 403);
        }
      }
      path = reg?.receipt_image_url || null;
    } else if (openPlayRegistrationId) {
      if (!canViewDashboardReceipt(caller.account)) {
        return json({ error: "Forbidden" }, 403);
      }
      const { data: reg, error: regError } = await db
        .from("open_play_registrations")
        .select("receipt_image_url")
        .eq("id", openPlayRegistrationId)
        .maybeSingle();
      if (regError) return json({ error: "Receipt could not be loaded" }, 500);
      path = reg?.receipt_image_url || null;
    } else {
      const { data: bk, error: bookingError } = await db.from("bookings")
        .select(
          "receipt_image_url,host_booking,host_user_id,created_by_user_id",
        )
        .eq("ref", bookingRef).maybeSingle();
      if (bookingError) {
        return json({ error: "Receipt could not be loaded" }, 500);
      }
      if (!bk) return json({ error: "No receipt on file" }, 404);
      if (!canViewBookingReceipt(caller.account, caller.userId, bk)) {
        return json({ error: "Forbidden" }, 403);
      }
      path = bk?.receipt_image_url || null;
    }
    if (!path) return json({ error: "No receipt on file" }, 404);
    const { data: signed, error: signErr } = await db.storage.from("receipts")
      .createSignedUrl(path, 300);
    if (signErr || !signed) {
      return json({ error: errMsg(signErr || "sign failed") }, 500);
    }
    return json({ ok: true, url: signed.signedUrl });
  }
  if (action !== "verify") return json({ error: "Unsupported action" }, 400);

  let receiptLeaseKey = "";
  let receiptLeaseToken = "";

  // ── verify a freshly-uploaded receipt ─────────────────────────────────────
  try {
    const bookingRef = String(body.bookingRef || "");
    const bookingAccessToken = String(body.bookingAccessToken || "");
    let provider = normalizedProvider(String(body.provider || "gcash"));
    let imageBase64 = String(body.imageBase64 || "");
    // Optional inline data supports pre-save Open Play registration receipts.
    // A matching saved booking still takes precedence over every inline field.
    const inlineBookingData =
      (body.bookingData && typeof body.bookingData === "object")
        ? body.bookingData as Record<string, unknown>
        : null;
    if (!bookingRef) return json({ error: "bookingRef required" }, 400);
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/i.test(bookingRef)) {
      return json({ error: "Invalid bookingRef" }, 400);
    }
    if (!imageBase64 && !uploadedImage) {
      return json({ error: "receipt file or imageBase64 required" }, 400);
    }

    let bytes: Uint8Array;
    try {
      bytes = uploadedImage
        ? new Uint8Array(await uploadedImage.arrayBuffer())
        : base64ToBytes(imageBase64);
    } catch {
      return json({ error: "Receipt image encoding is invalid" }, 400);
    }
    if (bytes.length === 0) return json({ error: "Empty image" }, 400);
    if (bytes.length > MAX_BYTES) {
      return json({ error: "Image too large (max 5 MB)" }, 400);
    }
    // Never trust a browser-supplied MIME label. Detect the actual file type
    // before storing the upload or sending it to the billable OCR API.
    const contentType = detectReceiptImageContentType(bytes);
    if (!contentType) {
      return json({
        error: "Receipt must be a valid JPG, PNG, or WebP image",
      }, 415);
    }
    // A saved court booking is always authoritative. Inline data exists for
    // pre-save Open Play registrations; it must never override a persisted
    // booking's price, host flag, payment method, or customer identity.
    const { data: persistedRow, error: bookingErr } = await db
      .from("bookings")
      .select(
        "ref, booking_group_ref, court_id, court_name, slots, total, downpayment, host_booking, host_user_id, created_by_user_id, customer_access_token_hash, gcash_ref, payment_method, date, start_time, end_time, email, payment_status, status, full_name, created_at, receipt_image_url, receipt_image_hash, receipt_phash, receipt_status, receipt_flags, receipt_extracted, receipt_confidence, receipt_verified_at",
      )
      .eq("ref", bookingRef)
      .maybeSingle();
    if (bookingErr) return json({ error: "Booking could not be loaded" }, 500);

    // Authentication is loaded once so a staff member or the owning host can
    // authorize a persisted receipt mutation without the customer access token.
    // An anonymous Supabase key is not a user session and produces no caller.
    let caller: ReceiptCaller | null;
    try {
      caller = await loadReceiptCaller(req, db);
    } catch (error) {
      console.error("receipt caller lookup failed:", errMsg(error));
      return json({ error: "Receipt authorization could not be checked" }, 500);
    }

    let booking: Record<string, unknown>;
    let bookingMutationScope: BookingMutationScope = {};
    let inlinePricingKind: "open_play" | "host_session" | null = null;
    let authorizedReceiptCaller = false;
    const hasPersistedBooking = !!persistedRow;
    if (persistedRow) {
      booking = { ...(persistedRow as Record<string, unknown>) };
      const storedAccessTokenHash = String(
        booking.customer_access_token_hash || "",
      );
      const customerTokenAuthorized = await bookingAccessTokenMatches(
        bookingAccessToken,
        storedAccessTokenHash,
      );
      authorizedReceiptCaller = !!caller &&
        canViewBookingReceipt(caller.account, caller.userId, booking);
      if (customerTokenAuthorized) {
        bookingMutationScope = {
          customerAccessTokenHash: storedAccessTokenHash,
        };
      } else {
        if (!authorizedReceiptCaller) {
          return json({
            error: "Receipt verification is not authorized for this booking",
          }, 403);
        }
        // Even a trusted operator should update only the target reservation's
        // ownership boundary when a group reference is present. This makes an
        // accidental/colliding group id harmless.
        if (/^[0-9a-f]{64}$/.test(storedAccessTokenHash)) {
          bookingMutationScope = {
            customerAccessTokenHash: storedAccessTokenHash,
          };
        } else if (booking.host_booking === true && booking.host_user_id) {
          bookingMutationScope = {
            hostUserId: String(booking.host_user_id),
          };
        }
      }
      delete booking.customer_access_token_hash;
      const persistedStatus = String(booking.status || "");
      const persistedPaymentStatus = String(booking.payment_status || "");
      const terminal =
        ["confirmed", "cancelled", "completed", "forfeited"].includes(
          persistedStatus,
        ) ||
        ["paid", "downpayment_paid", "deposit_retained", "rejected"].includes(
          persistedPaymentStatus,
        );
      if (terminal) {
        const storedReceiptStatus = String(booking.receipt_status || "");
        const finalStatus = storedReceiptStatus === "rejected" ||
            persistedStatus === "cancelled" ||
            persistedPaymentStatus === "rejected"
          ? "rejected"
          : storedReceiptStatus === "manual_review"
          ? "manual_review"
          : "auto_approved";
        return json({
          ok: true,
          status: finalStatus,
          flags: [],
          publicReason: finalStatus === "rejected"
            ? "This booking was already rejected."
            : finalStatus === "manual_review"
            ? "This booking is already awaiting owner review."
            : "Payment was already verified.",
          extracted: booking.receipt_extracted || null,
          confidence: booking.receipt_confidence ?? null,
          receiptImageUrl: booking.receipt_image_url || null,
          receiptImageHash: booking.receipt_image_hash || null,
          receiptPhash: booking.receipt_phash || null,
          receiptVerifiedAt: booking.receipt_verified_at || null,
          paymentStatus: persistedPaymentStatus || null,
          bookingStatus: persistedStatus || null,
          message: "This booking has already been processed.",
        });
      }
      // Timing is the only field an inline payload may supplement for a saved
      // booking, and only when the persisted value is absent.
      if (!booking.created_at && inlineBookingData?.created_at) {
        booking.created_at = inlineBookingData.created_at;
      }
      if (!booking.date && inlineBookingData?.date) {
        booking.date = inlineBookingData.date;
      }
    } else {
      if (!inlineBookingData) return json({ error: "Booking not found" }, 404);
      const hasCourtShape = !!(
        inlineBookingData.court_id ||
        inlineBookingData.courtId ||
        inlineBookingData.booking_group_ref ||
        inlineBookingData.groupRef ||
        (Array.isArray(inlineBookingData.slots) &&
          inlineBookingData.slots.length > 0) ||
        inlineBookingData.host_booking === true ||
        inlineBookingData.hostBooking === true
      );
      if (hasCourtShape) {
        return json({
          error: "Court booking must be saved before receipt verification",
        }, 400);
      }
      booking = inlineBookingData;
      inlinePricingKind = booking.host_session_id
        ? "host_session"
        : "open_play";
    }
    const authoritativeProvider = paymentMethodProvider(
      booking.payment_method ?? booking.paymentMethod,
    );
    if (!authoritativeProvider) {
      return json({
        error:
          "Receipt OCR is available only for a saved digital payment method.",
        code: "DIGITAL_PAYMENT_METHOD_REQUIRED",
      }, 400);
    }
    // The saved payment method is authoritative; a caller cannot relabel a
    // cash/unknown booking or select weaker provider rules in the request.
    provider = authoritativeProvider;

    // A disabled or unconfigured payment method must fail before Storage is
    // written or a short-lived hold can be promoted to a permanent
    // manual-review state by the service role.
    const { data: methodReady, error: methodReadyError } = await db.rpc(
      "public_payment_method_ready",
      { p_method: provider },
    );
    if (methodReadyError) {
      return json({
        error: "Payment method availability could not be checked.",
        code: "PAYMENT_METHOD_CHECK_UNAVAILABLE",
      }, 503);
    }
    if (methodReady !== true) {
      return json({
        error: "This payment method is not currently enabled.",
        code: "PAYMENT_METHOD_DISABLED",
      }, 409);
    }

    if (hasPersistedBooking) {
      receiptLeaseKey = String(booking.booking_group_ref || bookingRef).trim();
      const { data: leaseRows, error: leaseError } = await db.rpc(
        "claim_receipt_verification_lease",
        { p_booking_key: receiptLeaseKey, p_lease_seconds: 600 },
      );
      const lease = Array.isArray(leaseRows) ? leaseRows[0] : leaseRows;
      if (leaseError) {
        console.error("receipt verification lease failed:", errMsg(leaseError));
        return json({
          error:
            "Receipt verification could not start safely. Please try again shortly.",
          code: "RECEIPT_LEASE_UNAVAILABLE",
        }, 503);
      }
      if (!lease?.claimed || !lease?.claim_token) {
        return json({
          error:
            "This receipt is already being verified. Please wait for the result and do not upload or pay again.",
          code: "RECEIPT_VERIFICATION_IN_PROGRESS",
          retryAfterSeconds: 15,
        }, 409);
      }
      receiptLeaseToken = String(lease.claim_token);
    }

    // Save the evidence before pricing, perceptual hashing, or OCR. Large
    // mobile screenshots can make those later steps slow or memory-heavy; a
    // disconnect there must never leave the owner without the paid receipt.
    const imageHash = await sha256Hex(bytes);
    const ext = contentType === "image/png"
      ? "png"
      : contentType === "image/webp"
      ? "webp"
      : "jpg";
    const objectPath = `${bookingRef}/${imageHash}.${ext}`;
    console.log("receipt checkpoint: storing", {
      bookingRef,
      bytes: bytes.length,
      contentType,
    });
    const { error: upErr } = await db.storage.from("receipts").upload(
      objectPath,
      bytes,
      {
        contentType,
        // The hash-derived path makes a customer retry idempotent.
        upsert: true,
      },
    );
    if (upErr) {
      console.error("receipt upload failed:", errMsg(upErr));
      return json({
        error:
          "Receipt image could not be stored. Please upload the receipt again.",
      }, 500);
    }

    if (hasPersistedBooking) {
      const { data: safeRows, error: safeStateErr } = await bookingUpdateQuery(
        db,
        booking,
        {
          status: "pending",
          payment_status: "for_verification",
          receipt_image_url: objectPath,
          receipt_image_hash: imageHash,
          receipt_status: "manual_review",
          receipt_flags: [],
        },
        bookingMutationScope,
      )
        .in("status", ["verifying", "pending"])
        .in("payment_status", ["unpaid", "pending", "for_verification"])
        .select("ref");
      if (safeStateErr || !safeRows?.length) {
        console.error(
          "receipt safe-state update failed:",
          safeStateErr
            ? errMsg(safeStateErr)
            : "no active booking rows updated",
        );
        return json({
          error:
            "Receipt was stored but could not be attached to the booking. Please contact the owner with your booking reference.",
        }, 500);
      }
      booking = {
        ...booking,
        status: "pending",
        payment_status: "for_verification",
        receipt_image_url: objectPath,
        receipt_image_hash: imageHash,
        receipt_status: "manual_review",
      };
      console.log("receipt checkpoint: attached", {
        bookingRef,
        rows: safeRows.length,
        objectPath,
      });
    }

    const settingsRows = await db.from("settings").select("key,value");
    const settingsError = settingsRows.error ? errMsg(settingsRows.error) : "";
    const settings: Record<string, string> = {};
    (settingsRows.data || []).forEach((r: { key: string; value: string }) => {
      settings[r.key] = r.value;
    });
    const expectedMerchant = expectedMerchantForProvider(settings, provider);
    const expectedNumber = expectedMerchant.number;
    const expectedName = expectedMerchant.name;
    let pricingError = "";
    let expectedAmount = 0;
    let expectedTotal = 0;
    let autoPaymentStatus: "paid" | "downpayment_paid" | null = null;
    let bookingGroup: Array<Record<string, unknown>> = [booking];
    try {
      if (inlinePricingKind === "host_session") {
        const amounts = await expectedHostSessionAmounts(db, booking);
        expectedTotal = amounts.total;
        expectedAmount = amounts.due;
      } else if (inlinePricingKind === "open_play") {
        const amounts = expectedOpenPlayAmounts(booking, settings);
        expectedTotal = amounts.total;
        expectedAmount = amounts.due;
      } else {
        bookingGroup = await loadBookingGroup(
          db,
          booking,
          bookingMutationScope,
        );
        const amounts = await expectedBookingGroupAmounts(
          db,
          bookingGroup,
          settings,
        );
        expectedTotal = amounts.total;
        expectedAmount = amounts.due;
      }
      if (hasPersistedBooking) {
        autoPaymentStatus = classifyStoredSessionPayment(
          expectedAmount,
          uniqueBookingRows(bookingGroup).map((row) => ({
            total: row.total,
            downpayment: row.downpayment,
            hostBooking: row.host_booking === true,
          })),
        );
      }
    } catch (err) {
      pricingError = errMsg(err);
    }
    const bookingGroupRefs = new Set(
      bookingGroup.map((row) => String(row.ref || "")).filter(Boolean),
    );
    const bookingGroupRef = String(
      booking.booking_group_ref ||
        bookingGroup.find((row) => row.booking_group_ref)?.booking_group_ref ||
        "",
    ).trim();
    const ledgerClaimScope = bookingGroupRef ? "booking_group" : "booking";
    const ledgerClaimOwnerId = bookingGroupRef || bookingRef;
    const ledgerClaimBelongsToBooking = (
      row: Record<string, unknown> | null,
    ): boolean => {
      if (!row) return false;
      const scope = String(row.claim_scope || "");
      const ownerId = String(row.claim_owner_id || "");
      if (scope && ownerId) {
        return scope === ledgerClaimScope && ownerId === ledgerClaimOwnerId;
      }
      // Rolling-deploy compatibility for a ledger row written before the
      // explicit ownership columns existed.
      return bookingGroupRefs.has(String(row.booking_ref || ""));
    };

    // Hashes are stored for audit only. GCash validity is based on receipt details.
    const phash = await dHash(bytes, contentType);

    // Google Vision still expects base64. Delay this allocation until after
    // Storage and the manual-review checkpoint have safely completed.
    if (!imageBase64) imageBase64 = bytesToBase64(bytes);

    const flags: string[] = [];

    if (settingsError) flags.push("SETTINGS_UNAVAILABLE");
    if (!expectedNumber && !expectedName) {
      // Missing merchant identity is configuration uncertainty, never grounds
      // for approval or cancellation. Keep the receipt for an owner review.
      flags.push("MERCHANT_CONFIG_MISSING");
    }
    if (
      provider === "gcash" && !expectedNumber &&
      !flags.includes("MERCHANT_CONFIG_MISSING")
    ) {
      // A QR image alone cannot prove which recipient the screenshot paid.
      // GCash auto-approval requires a configured full mobile number.
      flags.push("MERCHANT_CONFIG_MISSING");
    }
    if (provider === "gotyme" || provider === "pnb") {
      // These providers currently have only generic OCR extraction. Until
      // recipient/method/date/time rules are provider-specific, never
      // auto-approve them from generic text alone.
      flags.push("PROVIDER_REVIEW_REQUIRED");
    }

    // Do not flag duplicate-looking images. GCash/BDO Pay/Maya receipt screens
    // share the same layout, so perceptual image matching creates false flags.
    // Reuse protection is handled by exact payment refs/invoices below.

    // ── OCR ─────────────────────────────────────────────────────────────────
    const visionKey = Deno.env.get("GOOGLE_VISION_API_KEY") || "";
    const typedRef = normalizeReferenceForProvider(
      String(booking.gcash_ref || ""),
      provider,
    );
    let ocrText = "";
    let ocrConfidence = 0;
    let ocrConfidenceSource: OcrResult["confidenceSource"] = "none";
    let ocrProvider: OcrResult["provider"] = "none";
    let ocrPrimaryProvider: OcrResult["primaryProvider"] = "none";
    let ocrFallbackProvider: OcrResult["fallbackProvider"] | null = null;
    let ocrFallbackReason: string | null = null;
    let ocrError: string | null = null;
    try {
      const ocr = await runOCR(visionKey, imageBase64, provider, typedRef);
      ocrText = ocr.text;
      ocrConfidence = ocr.confidence;
      ocrConfidenceSource = ocr.confidenceSource;
      ocrProvider = ocr.provider;
      ocrPrimaryProvider = ocr.primaryProvider || ocr.provider;
      ocrFallbackProvider = ocr.fallbackProvider || null;
      ocrFallbackReason = ocr.fallbackReason || null;
      ocrError = ocr.error || null;
    } catch (e) {
      console.error("Google Vision OCR failed:", errMsg(e));
    }
    if (!visionKey) {
      // No OCR provider configured at all — cannot verify content, manual review.
      flags.push("OCR_UNAVAILABLE");
    } else if (ocrError) {
      // Provider/network failures are uncertain and must go to manual review;
      // they are not evidence that the customer uploaded a fake receipt.
      flags.push("OCR_UNAVAILABLE");
    } else if (!ocrText) {
      // Google Vision ran but found no text. A blank upload and a genuine but
      // blurry receipt are indistinguishable here, so preserve the booking and
      // send it to manual review rather than auto-cancelling a paid customer.
      flags.push("IMAGE_UNREADABLE");
    }

    // ── field extraction ────────────────────────────────────────────────────
    const gcashParse: GcashReceiptParse | null = provider === "gcash"
      ? parseGcashReceipt(ocrText, { typedReference: typedRef })
      : null;
    const gcashRecipient: GcashRecipientComparison | null = gcashParse
      ? compareGcashRecipient(gcashParse.receiver, {
        phone: expectedNumber,
        name: expectedName,
      })
      : null;
    const extractedRef = provider === "gcash"
      ? gcashParse?.reference.value || null
      : extractReference(ocrText, provider, typedRef);
    const extractedInvoice = provider === "bdopay"
      ? extractBdoInvoiceNumber(ocrText)
      : null;
    const extractedInstapayRefNo = provider === "maya"
      ? extractMayaInstapayRefNo(ocrText)
      : null;
    const extractedBpiTransactionRefNo = provider === "bpi"
      ? extractBpiTransactionRefNo(ocrText)
      : null;
    const amountExtraction = provider === "gcash"
      ? gcashParse?.amount || null
      : provider === "maya"
      ? extractReceiptAmount(ocrText, { provider })
      : null;
    // A weak or ambiguous Maya read is never evidence of underpayment. It is
    // stored for diagnostics but routed to manual review as unreadable.
    const extractedAmount = amountExtraction
      ? (amountExtraction.reliable ? amountExtraction.amount : null)
      : extractAmount(ocrText);
    const genericReceiptTimestamp = parseReceiptDateTime(ocrText);
    const receiptDate = provider === "gcash"
      ? gcashParse?.timestamp.date || null
      : genericReceiptTimestamp.date;
    const receiptDateTime = provider === "gcash"
      ? (gcashParse?.timestamp.instant
        ? new Date(gcashParse.timestamp.instant)
        : null)
      : genericReceiptTimestamp.shifted;
    const bookingStartedWallClock = toPhWallClockDate(
      booking.created_at || booking.createdAt,
    );
    const bookingStartedInstant = (() => {
      const parsed = new Date(
        String(booking.created_at || booking.createdAt || ""),
      );
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })();
    const bookingStartedAt = provider === "gcash"
      ? bookingStartedInstant
      : bookingStartedWallClock;
    const bookingStartedDate = bookingStartedWallClock
      ? bookingStartedWallClock.toISOString().slice(0, 10)
      : null;
    const receiptAgeMinutes = bookingStartedAt && receiptDateTime
      ? (receiptDateTime.getTime() - bookingStartedAt.getTime()) / 60000
      : null;
    if (provider === "gcash" && typedRef.length !== 13) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "bdopay" && !isBdoPayReference(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "maya" && !isMayaReference(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }
    if (provider === "bpi" && !isBpiConfirmationNo(typedRef)) {
      flags.push("REF_FORMAT_INVALID");
    }

    // ── content checks (only when OCR text exists) ──────────────────────────
    if (ocrText) {
      if (selectedMethodMismatch(provider, ocrText)) {
        flags.push("METHOD_MISMATCH");
      }

      if (provider === "gcash") {
        // Dedicated GCash parser. OCR observations stay independent from the
        // customer-typed reference and from configured recipient values.
        if (!gcashParse || !gcashRecipient) {
          flags.push("GCASH_RECEIPT_UNREADABLE");
        } else if (!extractedRef && !flags.includes("REF_FORMAT_INVALID")) {
          flags.push("REF_UNREADABLE");
        } else if (gcashParse.reference.typedMatch === "mismatch") {
          flags.push("REF_MISMATCH");
        } else if (
          gcashParse.reference.source !== "ref_label" ||
          gcashParse.reference.confidence !== "high"
        ) {
          flags.push("REF_LABEL_UNREADABLE");
        }

        if (pricingError) flags.push("PRICING_UNAVAILABLE");
        else if (
          extractedAmount == null || !gcashParse?.amount.reliable ||
          gcashParse?.amount.ambiguous
        ) flags.push("AMOUNT_UNREADABLE");
        else if (gcashParse?.amount.conflictingPrimaryAmounts) {
          flags.push("AMOUNT_REVIEW");
        } else if (!closeMoney(extractedAmount, expectedAmount)) {
          flags.push("AMOUNT_MISMATCH");
        }

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) {
          flags.push("DATE_NOT_TODAY");
        }
        if (!receiptDateTime || !bookingStartedAt) {
          flags.push("TIME_UNREADABLE");
        } else {
          if (
            (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
          ) flags.push("TIME_FUTURE");
          else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
            flags.push("TIME_EXPIRED");
          }
        }

        if (
          gcashParse?.indicators.classification !== "gcash" ||
          !gcashParse?.indicators.sentViaGcash ||
          !gcashParse?.indicators.totalAmountSent ||
          !gcashParse?.indicators.referenceLabel ||
          !gcashParse?.indicators.amountLabel
        ) {
          flags.push("GCASH_RECEIPT_UNREADABLE");
        }

        if (gcashRecipient?.phone === "mismatch") {
          flags.push("WRONG_GCASH_NUMBER");
        } else if (gcashRecipient?.phone !== "exact") {
          flags.push("NUMBER_UNREADABLE");
        }

        if (gcashRecipient?.name === "mismatch") {
          flags.push("RECEIVER_NAME_MISMATCH");
        } else if (
          expectedName && gcashRecipient?.phone !== "exact" &&
          gcashRecipient?.name !== "exact" &&
          gcashRecipient?.name !== "masked_compatible"
        ) {
          flags.push("RECEIVER_NAME_UNREADABLE");
        }

        const groupPaymentConsistent = bookingGroup.length > 0 &&
          bookingGroup.every((row) =>
            paymentMethodProvider(row.payment_method) === "gcash" &&
            normalizeReferenceForProvider(
                String(row.gcash_ref || ""),
                "gcash",
              ) === typedRef &&
            ["verifying", "pending"].includes(String(row.status || "")) &&
            ["pending", "for_verification", "unpaid"].includes(
              String(row.payment_status || ""),
            )
          );
        if (!groupPaymentConsistent || !autoPaymentStatus) {
          flags.push("BOOKING_GROUP_PAYMENT_MISMATCH");
        }
      } else if (provider === "bdopay") {
        // BDO Pay focused path: do not require GCash/GXI/Maya evidence here.
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("PRICING_UNAVAILABLE");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          flags.push("AMOUNT_MISMATCH");
        }

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) {
          flags.push("DATE_NOT_TODAY");
        }
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if (
          (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
        ) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
          flags.push("TIME_EXPIRED");
        }

        if (!hasBdoPayIndicator(ocrText)) flags.push("BDO_PAY_UNREADABLE");
        if (!hasExpectedReceiverName(ocrText, expectedName)) {
          flags.push("RECEIVER_NAME_UNREADABLE");
        }
        if (!extractedInvoice) flags.push("INVOICE_UNREADABLE");
      } else if (provider === "maya") {
        // Maya focused path: do not require GCash/GXI/BDO Pay evidence here.
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("PRICING_UNAVAILABLE");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          // Maya's flattened OCR can still turn a damaged/split thousands
          // value into a plausible smaller number. Keep the booking pending
          // for an owner to compare with the stored image; never auto-approve
          // the short amount and never auto-cancel from this heuristic alone.
          flags.push("AMOUNT_REVIEW");
        }

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) {
          flags.push("DATE_NOT_TODAY");
        }
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if (
          (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
        ) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
          flags.push("TIME_EXPIRED");
        }

        if (!hasMayaIndicator(ocrText)) flags.push("MAYA_UNREADABLE");
        if (!hasInstapayQrphIndicator(ocrText)) {
          flags.push("INSTAPAY_QRPH_UNREADABLE");
        }
        if (!hasExpectedReceiverName(ocrText, expectedName)) {
          flags.push("RECEIVER_NAME_UNREADABLE");
        }
      } else if (provider === "bpi") {
        // BPI focused path: require BPI + InstaPay + GCash/G-Xchange destination,
        // but do not run the GCash-to-GCash verifier.
        if (!extractedRef) flags.push("BPI_CONFIRMATION_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("PRICING_UNAVAILABLE");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          flags.push("AMOUNT_MISMATCH");
        }

        if (!receiptDate) flags.push("DATE_UNREADABLE");
        else if (bookingStartedDate && receiptDate !== bookingStartedDate) {
          flags.push("DATE_NOT_TODAY");
        }
        if (!receiptDateTime) flags.push("TIME_UNREADABLE");
        else if (!bookingStartedAt) flags.push("TIME_UNREADABLE");
        else if (
          (receiptAgeMinutes as number) < -PAYMENT_EARLY_TOLERANCE_MINUTES
        ) flags.push("TIME_FUTURE");
        else if ((receiptAgeMinutes as number) > PAYMENT_WINDOW_MINUTES) {
          flags.push("TIME_EXPIRED");
        }

        if (!hasBpiIndicator(ocrText)) flags.push("BPI_UNREADABLE");
        if (!hasInstapayQrphIndicator(ocrText)) {
          flags.push("INSTAPAY_QRPH_UNREADABLE");
        }
        if (!hasGcashGxiDestination(ocrText)) {
          flags.push("GXI_DESTINATION_UNREADABLE");
        }
        if (!hasExpectedReceiverName(ocrText, expectedName)) {
          flags.push("RECEIVER_NAME_UNREADABLE");
        }
      } else {
        if (!extractedRef) flags.push("REF_UNREADABLE");
        else if (typedRef && extractedRef !== typedRef) {
          flags.push("REF_MISMATCH");
        }

        if (pricingError) flags.push("PRICING_UNAVAILABLE");
        else if (extractedAmount == null) flags.push("AMOUNT_UNREADABLE");
        else if (extractedAmount < expectedAmount - PESO_TOLERANCE) {
          flags.push("AMOUNT_MISMATCH");
        }
      }

      // This heuristic is not proof of fraud. OCR can miss labels on a real
      // screenshot, so flag it for an owner instead of auto-cancelling.
      if (provider !== "gcash" && !looksLikeGcashReceipt(ocrText)) {
        flags.push("SUSPECTED_FAKE");
      }
    }
    if (editedBySoftware(bytes)) flags.push("EDITED_METADATA");

    // Auto-verifying GCash requires a high-quality OCR read.
    const minimumOcrConfidence = provider === "gcash" ? 0.9 : 0.55;
    if (
      ocrText &&
      (
        ocrConfidence < minimumOcrConfidence ||
        (provider === "gcash" && ocrConfidenceSource !== "native")
      )
    ) {
      flags.push("LOW_OCR_CONFIDENCE");
    }

    // ── reference reuse / replay guard ──────────────────────────────────────
    // For GCash, a duplicate is terminal only when a high-confidence labeled
    // OCR reference independently matches the customer's stored reference.
    // A typed-only collision may be a typo, so it remains a soft possible
    // duplicate for owner review. Other providers retain their existing
    // extracted-reference behavior.
    // GCash refs are stored as digits only; other providers are namespaced so
    // same-looking references from different banks do not collide.
    const gcashReferenceProven = provider === "gcash" &&
      // A collision is terminal only when it is the sole failed check on an
      // otherwise auto-verifiable GCash receipt. Low-confidence, conflicting,
      // or incomplete evidence must stay pending for an owner.
      flags.length === 0 &&
      ocrProvider === "google_vision" &&
      ocrConfidenceSource === "native" &&
      ocrConfidence >= minimumOcrConfidence &&
      /^\d{13}$/.test(typedRef) &&
      gcashParse?.reference.value === typedRef &&
      gcashParse.reference.source === "ref_label" &&
      gcashParse.reference.confidence === "high" &&
      gcashParse.reference.typedMatch === "match" &&
      gcashParse.indicators.classification === "gcash" &&
      gcashParse.indicators.sentViaGcash &&
      gcashParse.indicators.totalAmountSent &&
      gcashParse.indicators.referenceLabel &&
      gcashParse.indicators.amountLabel;
    const rawRefForDedupe = provider === "gcash"
      ? (/^\d{13}$/.test(typedRef) ? typedRef : null)
      : extractedRef || typedRef || null;
    const refForDedupe = rawRefForDedupe
      ? provider === "gcash"
        ? rawRefForDedupe
        : `${provider}:${rawRefForDedupe}`
      : null;
    const dedupeKeys: Array<
      { key: string; providerKey: string; duplicateFlag: string }
    > = [];
    if (refForDedupe) {
      dedupeKeys.push({
        key: refForDedupe,
        providerKey: provider,
        duplicateFlag: provider === "gcash" && !gcashReferenceProven
          ? "POSSIBLE_DUPLICATE_REF"
          : "DUPLICATE_REF",
      });
    }
    if (provider === "bdopay" && extractedInvoice) {
      dedupeKeys.push({
        key: `bdopay_invoice:${extractedInvoice}`,
        providerKey: "bdopay_invoice",
        duplicateFlag: "DUPLICATE_INVOICE",
      });
    }
    if (provider === "maya" && extractedInstapayRefNo) {
      dedupeKeys.push({
        key: `maya_instapay:${extractedInstapayRefNo}`,
        providerKey: "maya_instapay",
        duplicateFlag: "DUPLICATE_INSTAPAY_REF",
      });
    }
    if (provider === "bpi" && extractedBpiTransactionRefNo) {
      dedupeKeys.push({
        key: `bpi_transaction:${extractedBpiTransactionRefNo}`,
        providerKey: "bpi_transaction",
        duplicateFlag: "DUPLICATE_BPI_TRANSACTION_REF",
      });
    }

    for (const item of dedupeKeys) {
      const { data: existingRef } = await db
        .from("used_gcash_refs")
        .select("booking_ref,claim_scope,claim_owner_id")
        .eq("gcash_ref", item.key)
        .maybeSingle();
      if (existingRef && !ledgerClaimBelongsToBooking(existingRef)) {
        flags.push(item.duplicateFlag);
      }
    }

    // ── decision routing ────────────────────────────────────────────────────
    const hasHard = flags.some((f) => HARD_FLAGS.has(f));
    const hasProvenDuplicate = flags.some((flag) =>
      [
        "DUPLICATE_REF",
        "DUPLICATE_INVOICE",
        "DUPLICATE_INSTAPAY_REF",
        "DUPLICATE_BPI_TRANSACTION_REF",
      ].includes(flag)
    );
    const gcashCanAutoApprove = provider === "gcash" &&
      hasPersistedBooking &&
      autoPaymentStatus !== null &&
      flags.length === 0;
    let result: "auto_approved" | "manual_review" | "rejected" =
      gcashCanAutoApprove ? "auto_approved" : provider === "gcash"
        // GCash OCR mismatches are preserved for an owner instead of releasing
        // a possibly paid customer's slot. Only a proven reused reference is
        // terminal.
        ? (hasProvenDuplicate ? "rejected" : "manual_review")
        : hasHard
        ? "rejected"
        : "manual_review";

    let confidence = result === "auto_approved"
      ? ocrConfidence
      : result === "manual_review"
      ? 0.5
      : 0.1;

    const extracted = {
      ref: extractedRef,
      invoice: extractedInvoice,
      instapayRefNo: extractedInstapayRefNo,
      bpiConfirmationNo: provider === "bpi" ? extractedRef : null,
      bpiTransactionRefNo: extractedBpiTransactionRefNo,
      amount: extractedAmount,
      amountReliable: amountExtraction?.reliable ?? (extractedAmount != null),
      amountAmbiguous: amountExtraction?.ambiguous ?? false,
      amountReason: amountExtraction?.reason || "legacy_parser",
      amountEvidence: amountExtraction?.evidence || [],
      amountCandidates: amountExtraction?.candidates.map((candidate) => ({
        amount: candidate.amount,
        score: candidate.score,
        evidence: candidate.evidence,
        excluded: candidate.excluded,
        exclusionReasons: candidate.exclusionReasons,
      })) || [],
      date: receiptDate,
      time: receiptDateTime ? receiptDateTime.toISOString() : null,
      timePh12: provider === "gcash"
        ? formatPhInstantDateTime12(receiptDateTime)
        : formatPhDateTime12(receiptDateTime),
      bookingStartedAt: bookingStartedAt
        ? bookingStartedAt.toISOString()
        : null,
      bookingStartedAtPh12: provider === "gcash"
        ? formatPhInstantDateTime12(bookingStartedAt)
        : formatPhDateTime12(bookingStartedAt),
      bookingStartedDate,
      receiptAgeMinutes,
      allowedPaymentWindowMinutes: PAYMENT_WINDOW_MINUTES,
      allowedPaymentEarlyToleranceMinutes: PAYMENT_EARLY_TOLERANCE_MINUTES,
      expectedAmount,
      expectedTotal,
      autoPaymentStatus,
      provider,
      parserVersion: gcashParse ? "gcash_v1" : "legacy",
      gcash: gcashParse
        ? {
          reference: gcashParse.reference,
          amount: {
            value: gcashParse.amount.amount,
            reliable: gcashParse.amount.reliable,
            ambiguous: gcashParse.amount.ambiguous,
            reason: gcashParse.amount.reason,
            conflictingPrimaryAmounts:
              gcashParse.amount.conflictingPrimaryAmounts,
          },
          timestamp: gcashParse.timestamp,
          receiver: gcashParse.receiver,
          recipientComparison: gcashRecipient,
          indicators: gcashParse.indicators,
          issues: gcashParse.issues,
        }
        : null,
      ocrProvider,
      ocrPrimaryProvider,
      ocrFallbackProvider,
      ocrFallbackReason,
      ocrConfidence,
      ocrConfidenceSource,
      ocrTextLength: ocrText.length,
      expectedReceiverNumber:
        provider === "bdopay" || provider === "maya" || provider === "bpi"
          ? null
          : expectedNumber || null,
      expectedReceiverName: expectedName || null,
    };

    // ── persist outcome on the booking ──────────────────────────────────────
    const receiptVerifiedAt = new Date().toISOString();
    const statusUpdate: Record<string, unknown> = {};
    const metadataUpdate: Record<string, unknown> = {
      receipt_image_url: objectPath,
      receipt_image_hash: imageHash,
      receipt_phash: phash,
      receipt_extracted: extracted,
      receipt_verified_at: receiptVerifiedAt,
    };
    const refreshOutcomeUpdates = () => {
      delete statusUpdate.status;
      delete statusUpdate.payment_status;
      delete statusUpdate.paid_at;
      if (result === "auto_approved") {
        statusUpdate.status = "confirmed";
        statusUpdate.payment_status = autoPaymentStatus;
        statusUpdate.paid_at = receiptVerifiedAt;
      } else if (result === "manual_review") {
        statusUpdate.status = "pending";
        statusUpdate.payment_status = "for_verification";
      } else {
        statusUpdate.status = "cancelled";
        statusUpdate.payment_status = "rejected";
      }
      metadataUpdate.receipt_status = result;
      metadataUpdate.receipt_flags = flags;
      metadataUpdate.receipt_confidence = confidence;
    };
    refreshOutcomeUpdates();

    let finalUpdateError: string | null = null;
    let auditPersisted = false;
    let finalPaymentStatus = String(statusUpdate.payment_status || "");
    let finalBookingStatus = String(statusUpdate.status || "");

    // Skip DB update when booking hasn't been saved yet (pre-save verification flow).
    if (hasPersistedBooking) {
      if (result === "auto_approved") {
        const { data: finalizedRows, error: finalizeError } = await db.rpc(
          "finalize_gcash_receipt_auto_approval",
          {
            p_booking_ref: bookingRef,
            p_booking_refs: [...bookingGroupRefs].sort(),
            p_lease_key: receiptLeaseKey,
            p_lease_token: receiptLeaseToken,
            p_gcash_reference: extractedRef,
            p_payment_status: autoPaymentStatus,
            p_receipt_image_url: objectPath,
            p_receipt_image_hash: imageHash,
            p_receipt_phash: phash,
            p_receipt_flags: flags,
            p_receipt_extracted: extracted,
            p_receipt_confidence: confidence,
            p_receipt_verified_at: receiptVerifiedAt,
            p_raw_ocr_text: ocrText || null,
          },
        );
        if (finalizeError) {
          const finalizeMessage = errMsg(finalizeError);
          // The ledger raises this exact message after confirming that another
          // payment owns the reference. A generic 23505 can come from an
          // unrelated unique constraint and must remain manual review.
          const duplicateReference = /already been used for another payment/i
            .test(finalizeMessage);
          if (duplicateReference) {
            if (!flags.includes("DUPLICATE_REF")) flags.push("DUPLICATE_REF");
            result = "rejected";
            confidence = 0.1;
          } else {
            flags.push("AUTO_APPROVAL_FAILED");
            result = "manual_review";
            confidence = 0.5;
          }
          refreshOutcomeUpdates();
          finalPaymentStatus = String(statusUpdate.payment_status || "");
          finalBookingStatus = String(statusUpdate.status || "");
          console.error(
            "GCash auto-approval finalization failed:",
            finalizeMessage,
          );
        } else {
          auditPersisted = true;
          const finalized = Array.isArray(finalizedRows)
            ? finalizedRows.find((row) =>
              String(row.booking_ref) === bookingRef
            ) ||
              finalizedRows[0]
            : finalizedRows;
          finalPaymentStatus = String(
            finalized?.booking_payment_status || autoPaymentStatus || "",
          );
          finalBookingStatus = String(
            finalized?.booking_status || "confirmed",
          );
        }
      }

      if (provider === "gcash" && result !== "auto_approved") {
        const finalizeReview = async (
          reviewResult: "manual_review" | "rejected",
        ) =>
          await db.rpc("finalize_gcash_receipt_review", {
            p_booking_ref: bookingRef,
            p_booking_refs: [...bookingGroupRefs].sort(),
            p_lease_key: receiptLeaseKey,
            p_lease_token: receiptLeaseToken,
            p_gcash_reference: typedRef,
            p_result: reviewResult,
            p_receipt_image_url: objectPath,
            p_receipt_image_hash: imageHash,
            p_receipt_phash: phash,
            p_receipt_flags: flags,
            p_receipt_extracted: extracted,
            p_receipt_confidence: confidence,
            p_receipt_verified_at: receiptVerifiedAt,
            p_raw_ocr_text: ocrText || null,
          });

        let reviewResponse = await finalizeReview(result);
        if (reviewResponse.error && result === "rejected") {
          // Cancellation is allowed only when the transaction independently
          // proves the duplicate. Any race or validation failure falls back to
          // a held slot and owner review.
          flags.push("REJECTION_FINALIZATION_FAILED");
          result = "manual_review";
          confidence = 0.5;
          refreshOutcomeUpdates();
          reviewResponse = await finalizeReview("manual_review");
        }

        if (reviewResponse.error) {
          finalUpdateError = errMsg(reviewResponse.error);
          console.error(
            "GCash review finalization failed:",
            finalUpdateError,
          );

          // A stale lease commonly means a newer verifier or administrator
          // already completed the booking. Return that canonical terminal
          // state so the browser never downgrades it to pending.
          const { data: currentRow } = await db.from("bookings")
            .select(
              "status,payment_status,receipt_status,receipt_flags,receipt_extracted,receipt_confidence,receipt_image_url,receipt_image_hash,receipt_phash,receipt_verified_at",
            )
            .eq("ref", bookingRef)
            .maybeSingle();
          const currentStatus = String(currentRow?.status || "");
          const currentPayment = String(currentRow?.payment_status || "");
          const terminalRejected = currentStatus === "cancelled" ||
            currentPayment === "rejected";
          const terminalApproved =
            ["confirmed", "completed", "forfeited"].includes(currentStatus) ||
            ["paid", "downpayment_paid", "deposit_retained"].includes(
              currentPayment,
            );
          if (terminalRejected || terminalApproved) {
            const persistedResult = terminalRejected
              ? "rejected"
              : "auto_approved";
            return json({
              ok: true,
              status: persistedResult,
              flags: [],
              publicReason: publicReceiptMessage(
                persistedResult,
                Array.isArray(currentRow?.receipt_flags)
                  ? currentRow.receipt_flags
                  : [],
              ),
              extracted: currentRow?.receipt_extracted || null,
              confidence: currentRow?.receipt_confidence ?? null,
              receiptImageUrl: currentRow?.receipt_image_url || null,
              receiptImageHash: currentRow?.receipt_image_hash || null,
              receiptPhash: currentRow?.receipt_phash || null,
              receiptVerifiedAt: currentRow?.receipt_verified_at || null,
              paymentStatus: currentPayment || null,
              bookingStatus: currentStatus || null,
              message:
                "This booking was already processed by another verification request.",
            });
          }
        } else {
          auditPersisted = true;
          const reviewRows = reviewResponse.data;
          const finalized = Array.isArray(reviewRows)
            ? reviewRows.find((row) =>
              String(row.booking_ref) === bookingRef
            ) || reviewRows[0]
            : reviewRows;
          finalPaymentStatus = String(
            finalized?.booking_payment_status ||
              statusUpdate.payment_status ||
              "",
          );
          finalBookingStatus = String(
            finalized?.booking_status || statusUpdate.status || "",
          );
        }
      }

      if (provider !== "gcash" && result !== "auto_approved") {
        // Metadata and final status must be one conditional update. This acts as
        // a compare-and-set: one concurrent verifier can finalize a row, while a
        // later verifier cannot overwrite that terminal outcome or its evidence.
        const finalUpdate = { ...metadataUpdate, ...statusUpdate };
        const { data: updatedRows, error: updateErr } =
          await bookingUpdateQuery(
            db,
            booking,
            finalUpdate,
            bookingMutationScope,
          )
            .in("status", ["verifying", "pending"])
            .in("payment_status", ["unpaid", "pending", "for_verification"])
            .eq("receipt_image_hash", imageHash)
            .select("ref, status, payment_status");
        if (updateErr) {
          finalUpdateError = errMsg(updateErr);
          console.error("booking FINAL update failed:", finalUpdateError);
        } else if (!updatedRows || updatedRows.length === 0) {
          // A zero-row CAS commonly means a concurrent request already finalized
          // the booking. Confirm that before reporting a persistence failure.
          const { data: currentRow } = await db.from("bookings")
            .select(
              "status,payment_status,receipt_status,receipt_flags,receipt_extracted,receipt_confidence,receipt_image_url,receipt_image_hash,receipt_phash,receipt_verified_at",
            )
            .eq("ref", bookingRef)
            .maybeSingle();
          const currentStatus = String(currentRow?.status || "");
          const currentPayment = String(currentRow?.payment_status || "");
          const concurrentlyFinalized =
            ["confirmed", "cancelled", "completed", "forfeited"].includes(
              currentStatus,
            ) ||
            ["paid", "downpayment_paid", "deposit_retained", "rejected"]
              .includes(
                currentPayment,
              );
          if (concurrentlyFinalized) {
            const persistedReceiptStatus = String(
              currentRow?.receipt_status || "",
            );
            const persistedResult = persistedReceiptStatus === "rejected" ||
                currentStatus === "cancelled" || currentPayment === "rejected"
              ? "rejected"
              : persistedReceiptStatus === "manual_review"
              ? "manual_review"
              : "auto_approved";
            return json({
              ok: true,
              status: persistedResult,
              flags: [],
              publicReason: publicReceiptMessage(
                persistedResult,
                Array.isArray(currentRow?.receipt_flags)
                  ? currentRow.receipt_flags
                  : [],
              ),
              extracted: currentRow?.receipt_extracted || null,
              confidence: currentRow?.receipt_confidence ?? null,
              receiptImageUrl: currentRow?.receipt_image_url || null,
              receiptImageHash: currentRow?.receipt_image_hash || null,
              receiptPhash: currentRow?.receipt_phash || null,
              receiptVerifiedAt: currentRow?.receipt_verified_at || null,
              paymentStatus: currentPayment || null,
              bookingStatus: currentStatus || null,
              message:
                "This booking was already processed by another verification request.",
            });
          } else {
            finalUpdateError = `No non-terminal row matched ref=${bookingRef}`;
            console.error(finalUpdateError);
          }
        } else {
          const updated = updatedRows.find((row: Record<string, unknown>) =>
            String(row.ref || "") === bookingRef
          ) || updatedRows[0];
          finalPaymentStatus = String(
            updated?.payment_status || statusUpdate.payment_status || "",
          );
          finalBookingStatus = String(
            updated?.status || statusUpdate.status || "",
          );
        }
      }
    }

    // ── audit trail (immutable) ─────────────────────────────────────────────
    if (!auditPersisted) {
      const { error: auditError } = await db.from("receipt_verifications")
        .insert({
          booking_ref: bookingRef,
          result,
          flags,
          extracted,
          confidence,
          image_hash: imageHash,
          phash,
          raw_ocr_text: ocrText || null,
        });
      if (auditError) {
        console.error(
          "receipt verification audit insert failed:",
          errMsg(auditError),
        );
      }
    }

    // ── alert admin on anything needing a human ─────────────────────────────
    if (result === "manual_review" && hasPersistedBooking) {
      const paymentLabel = String(booking.payment_method || "digital")
        .toUpperCase();
      const displayRef = String(
        booking.booking_group_ref || bookingRef,
      );
      const alertCourts = uniqueBookingRows(bookingGroup).sort((a, b) =>
        String(a.court_name || "").localeCompare(
          String(b.court_name || ""),
          "en",
          { numeric: true },
        )
      );
      const totalHours = alertCourts.reduce(
        (sum, row) => sum + telegramCourtHours(row),
        0,
      );
      const dates = [
        ...new Set(alertCourts.map((row) => String(row.date || ""))),
      ].filter(Boolean);
      const sharedDate = dates.length === 1 ? dates[0] : "";
      const courtLines = alertCourts.map((row, index) => {
        const courtName = String(row.court_name || `Court ${index + 1}`);
        const datePrefix = sharedDate ? "" : `${telegramDate(row.date)} · `;
        return `🎾 ${escapeTelegramHtml(courtName)} · ${
          escapeTelegramHtml(datePrefix)
        }${escapeTelegramHtml(row.start_time || "")}–${
          escapeTelegramHtml(row.end_time || "")
        } · ${telegramPeso(row.total)}`;
      }).join("\n");
      const courtCountLabel = `${alertCourts.length} ${
        alertCourts.length === 1 ? "court" : "courts"
      } · ${telegramHours(totalHours)} ${
        alertCourts.length === 1 ? "hours" : "court-hours"
      }`;
      const totalPayment = expectedTotal || expectedAmount;
      await sendTelegram(
        `⚠️ <b>PAYMENT REVIEW</b>\n` +
          `👤 Player: ${
            escapeTelegramHtml(booking.full_name || "Player")
          }\n` +
          `📋 Ref: <code>${escapeTelegramHtml(displayRef)}</code>\n` +
          `💳 Payment: ${escapeTelegramHtml(paymentLabel)}\n` +
          `🕒 Submitted: ${
            escapeTelegramHtml(telegramDateTime(booking.created_at))
          }\n` +
          `🚩 Issue: ${
            escapeTelegramHtml(shortTelegramFlags(flags))
          }\n\n` +
          `🏟️ <b>COURT SCHEDULE</b>\n` +
          `${courtCountLabel}\n` +
          (sharedDate ? `📅 ${telegramDate(sharedDate)}\n` : "") +
          `${courtLines}\n` +
          `💰 <b>TOTAL PAYMENT: ${telegramPeso(totalPayment)}</b>\n\n` +
          `🔗 <a href="${telegramAdminUrl()}">Open the Paddle Rage dashboard</a>`,
      );
    }

    if (result === "rejected" && hasPersistedBooking && !finalUpdateError) {
      const customerEmail = String(booking.email || "").trim().toLowerCase();
      if (isEmailAddress(customerEmail)) {
        const reason = publicReceiptMessage(result, flags);
        const content = renderBookingCancellationEmail({
          bookingRef,
          fullName: String(booking.full_name || "Player"),
          courtName: String(booking.court_name || "Court"),
          date: String(booking.date || ""),
          startTime: String(booking.start_time || ""),
          endTime: String(booking.end_time || ""),
          total: Number(booking.total || 0),
          paid: 0,
          reason,
          paymentRejected: true,
        });
        try {
          await sendMailerooEmail({
            to: customerEmail,
            toName: String(booking.full_name || "Player"),
            subject: `Payment rejected: ${bookingRef} | Paddle Rage Pickleball`,
            html: content.html,
            plain: content.plain,
            tags: {
              message_type: "payment-rejected",
              booking_reference: bookingRef,
            },
          });
        } catch (emailError) {
          console.error(
            "Rejected-payment customer email failed:",
            errMsg(emailError),
          );
        }
      }
    }

    return json({
      ok: true,
      status: result,
      flags: [],
      publicReason: publicReceiptMessage(result, flags),
      extracted,
      confidence,
      receiptImageUrl: objectPath,
      receiptImageHash: imageHash,
      receiptPhash: phash,
      receiptVerifiedAt: metadataUpdate.receipt_verified_at,
      paymentStatus: hasPersistedBooking ? finalPaymentStatus || null : null,
      bookingStatus: hasPersistedBooking ? finalBookingStatus || null : null,
      ...(finalUpdateError
        ? { warning: `booking update failed: ${finalUpdateError}` }
        : {}),
      message: result === "auto_approved"
        ? "Payment verified. Your booking is confirmed."
        : result === "manual_review"
        ? "Received — the owner will verify your payment shortly."
        : "Your receipt could not be verified. Your booking has been cancelled — please try again with a valid receipt.",
    });
  } catch (err) {
    console.error("verify-gcash-receipt error:", errMsg(err));
    return json({ error: errMsg(err) }, 500);
  } finally {
    if (receiptLeaseKey && receiptLeaseToken) {
      const { error: releaseError } = await db.rpc(
        "release_receipt_verification_lease",
        {
          p_booking_key: receiptLeaseKey,
          p_claim_token: receiptLeaseToken,
        },
      );
      if (releaseError) {
        console.error(
          "receipt verification lease release failed:",
          errMsg(releaseError),
        );
      }
    }
  }
});

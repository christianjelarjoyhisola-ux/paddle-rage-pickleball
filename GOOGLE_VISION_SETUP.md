# Google Vision receipt OCR setup

The receipt-verification Edge Function uses the synchronous Cloud Vision
`images:annotate` REST endpoint with one `DOCUMENT_TEXT_DETECTION` feature per
receipt. Receipt bytes are sent as base64; no receipt image is made public.

## Google Cloud requirements

1. Use a dedicated Google Cloud project for Paddle Rage production OCR and
   attach a billing account.
2. Enable **Cloud Vision API** (`vision.googleapis.com`).
3. Create a standard API key named clearly, for example
   `paddle-rage-supabase-vision-prod`.
4. Under **API restrictions**, choose **Restrict key** and select only
   **Cloud Vision API**.
   As an optional advanced API Keys API restriction, limit the target further
   to `google.cloud.vision.v1.ImageAnnotator.BatchAnnotateImages`, the RPC
   behind the REST `images:annotate` request. Test this restriction before
   launch because the Cloud console normally exposes service-level selection.
5. Do not add a website/referrer restriction. The request is made by a
   Supabase Edge Function, not the customer's browser. Supabase Edge Functions
   also do not have stable outbound IP addresses, so a Google server-IP
   restriction would block legitimate calls.
6. For the strongest application restriction, route OCR through a private
   service with fixed egress or run the OCR worker on Google Cloud with an
   attached least-privilege service account. Do not put a long-lived service
   account JSON key in browser code or Git.

Official references:

- [Cloud Vision setup](https://cloud.google.com/vision/docs/setup)
- [Google API-key restrictions](https://cloud.google.com/docs/authentication/api-keys#api_key_restrictions)
- [Supabase Edge Functions do not have static egress IPs](https://supabase.com/docs/guides/troubleshooting/why-supabase-edge-functions-cannot-provide-static-egress-ips-for-whitelisting-3d78b0)

## Supabase secret

Store the key only as the Supabase project secret
`GOOGLE_VISION_API_KEY`. Never add the real value to `.env.example`, Git,
frontend JavaScript, screenshots, or support messages.

The function sends the credential using the `x-goog-api-key` header so it does
not appear in URLs or ordinary proxy logs.

After saving the secret, redeploy only `verify-gcash-receipt`, then test with a
non-sensitive sample receipt before accepting live bookings. An unavailable,
disabled, quota-limited, or misconfigured Vision API routes the receipt to
manual review rather than treating provider failure as proof of fraud.

## GCash verification threshold and routing

GCash uses a dedicated line-aware parser for the labeled 13-digit reference,
principal amount, Philippine date/time, recipient mobile number, masked name,
and receipt-layout indicators. Customer-entered values and configured merchant
values are comparisons only; they are never substituted for text that Vision
did not read.

A persisted GCash court booking is eligible for automatic approval only when
Google Vision supplies a native confidence score of at least **90%**, the
dedicated parser produces complete and unambiguous evidence, the exact
configured recipient mobile number matches, the canonical amount matches to
the centavo, and the payment falls within the booking's **15-minute** window.
The Edge Function also requires the complete saved booking group and payment
state to remain unchanged.

Pre-save Open Play and host-session scans never auto-approve. Any uncertain
GCash result—including a provider error, confidence below 90%, incomplete
timestamp, masked/partial mobile number, conflicting amount, or failed atomic
finalization—remains pending for owner review. A masked recipient name is
supporting evidence only and does not replace the full mobile-number match.
Only a reference proven to belong to another payment is automatically rejected.

The OCR percentage measures text-recognition quality, not independent proof
that money moved. Successful saved-booking approval therefore finishes through
the service-role-only `finalize_gcash_receipt_auto_approval` transaction, which
locks and revalidates canonical booking rows, claims the unique payment
reference, confirms the booking scope, and writes the audit record atomically.
A forged screenshot can still contain internally consistent OCR evidence.
Provider-signed transaction lookup or webhook confirmation is required before
describing this workflow as independently authenticated proof of payment.

## Cost and abuse controls

- Lower the project-level **requests per minute** and **text detection requests
  per minute** quotas to a conservative value that still covers expected peak
  bookings. Quotas enforce a ceiling; billing-budget alerts alone do not.
- Create budget alerts at useful thresholds and monitor Vision error rates and
  invocation volume.
- Keep the key restricted to Cloud Vision API and rotate it if it is ever
  exposed.
- Keep the included Turnstile boundary enabled for every public receipt upload.
  The server validates a fresh, single-use token before Storage or Vision; a
  browser cooldown and CORS are not security boundaries. See
  [TURNSTILE_SETUP.md](TURNSTILE_SETUP.md).

[Cloud Vision quotas](https://cloud.google.com/vision/quotas) are project-wide.

## Input contract

The function accepts valid JPEG, PNG, or WebP images up to 5 MB. It detects the
actual file signature instead of trusting the uploaded MIME label. The 5 MB
limit keeps the base64 JSON request below Cloud Vision's 10 MB JSON limit.
Google recommends approximately 1024 x 768 pixels for OCR; the browser already
downsizes unusually large phone screenshots while retaining readable detail.
Before its local perceptual-hash decoder runs, the Edge Function reads declared
JPEG/PNG/WebP dimensions and skips decoding images above 16 megapixels or 8192
pixels on either side, preventing a small compressed file from exhausting Edge
memory. Google Vision remains isolated from that local decoder.

See [Cloud Vision supported images and limits](https://cloud.google.com/vision/docs/supported-files).

## Privacy

Receipts may contain names, phone numbers, transaction identifiers, and payment
details. Tell customers that automated verification sends the uploaded receipt
to Google Cloud for OCR. Restrict receipt and OCR audit records to authorized
administrators, define a retention period, and avoid using real customer
receipts for development tests.

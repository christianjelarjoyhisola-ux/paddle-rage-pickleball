# Cloudflare Turnstile for bookings, registrations, and receipt OCR

Every anonymous court hold, Open Play registration, host-session registration,
host application, and receipt upload is gated by Cloudflare Turnstile. Receipt
tokens are checked before the private Storage write and billable Google Vision
call. The Edge Functions, not the browser, validate tokens with Cloudflare's
official `siteverify` endpoint and bind them to `public_registration`,
`host_application`, or `receipt_ocr` as appropriate. Tokens are short-lived and
single use, so the browser executes and removes a fresh widget for every
protected attempt.

Active owners, court owners, and staff may bypass the challenge. An active host
may bypass only when the server confirms that host owns the exact court booking
or host session. A client-side host hint never grants authorization.

Pre-save Open Play and host-session OCR is advisory: a clean scan is returned
as `manual_review` and does not reserve a payment-ledger reference. Only a
persisted court booking paid through GCash can auto-approve and claim a payment
reference.

That saved-booking path is intentionally strict. Automatic approval requires
all of the following:

- the saved payment method is GCash, and the complete booking group still has
  the same 13-digit reference and an unsettled `verifying`/`pending` state;
- the dedicated GCash parser finds a high-confidence labeled reference that
  exactly matches the customer-entered reference;
- the principal amount is reliable, unambiguous, internally consistent, and
  matches the canonical amount due to the centavo;
- the receipt date matches the booking-start date, and its timestamp is no more
  than two minutes early or 15 minutes after the hold began;
- the GCash layout indicators and full configured recipient mobile number
  match, with no competing payment-provider evidence;
- Google Vision supplies a native OCR confidence score of at least 90%,
  merchant settings and canonical pricing are available, and no review flag
  remains.

GCash masks recipient names by design. A masked name such as
`J•• KE••••H M.` is only supporting evidence; the exact full recipient mobile
number remains mandatory for automatic approval. Missing, partial, conflicting,
low-confidence, stale, or otherwise uncertain GCash evidence keeps the booking
`pending` with payment `for_verification`. It does not cancel a possibly paid
customer. Only a payment reference proven to be claimed by another payment is
terminally rejected.

Successful approval is not assembled through browser writes. The Edge Function
calls a service-role-only database finalizer that locks and re-checks the entire
booking scope, confirms the stored reference and amount, claims the payment
reference through the settled-payment trigger, confirms every booking row, and
writes the OCR audit entry in one transaction. A non-duplicate finalizer error
falls back to manual review.

This is strict OCR-based verification, not provider-authenticated settlement.
Screenshots can be forged; true independent proof requires a provider-signed
transaction lookup or webhook.

## 1. Create the widget

In Cloudflare Dashboard, open **Turnstile**, add a site, and choose the managed
widget mode. Add only the production hostnames that accept public bookings:

- `paddleragecdo.ph`
- `www.paddleragecdo.ph`

Add a Pages preview hostname only when receipt OCR is deliberately tested
there. Keep preview deployments out of the production widget otherwise.

Cloudflare provides two different values:

- **Site key**: public and safe for browser runtime configuration.
- **Secret key**: server-only; never put it in HTML, JavaScript, Git, browser
  storage, screenshots, or support messages.

Official references:

- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Turnstile explicit rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)
- [Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)

## 2. Configure local deployment values

Copy `.env.example` to the ignored `.env.local` file and set:

```dotenv
TURNSTILE_SITE_KEY=the_public_widget_site_key
TURNSTILE_SECRET_KEY=the_server_only_widget_secret
TURNSTILE_EXPECTED_HOSTNAMES=paddleragecdo.ph,www.paddleragecdo.ph
```

`runtime-config.js` contains Paddle Rage's production public site key.
`deploy-cloudflare-pages.ps1` writes only the public site key into the staged
file and accepts `TURNSTILE_SITE_KEY` as an override for Cloudflare test keys or
a future rotation. A preloaded `window.PB_TURNSTILE_SITE_KEY` also overrides the
runtime file for controlled browser tests.

`deploy-edge-functions.ps1` stores the secret and expected hostname list as
Supabase Edge Function secrets. It stops if the server secret is missing. The
expected-hostname list is defense in depth on top of the hostname allowlist in
the Cloudflare widget itself.

If deployment is done manually, configure the same server values in Supabase
project secrets and publish `runtime-config.js` with the correct public key. Do
not rename the `receipt_ocr`, `public_registration`, or `host_application`
actions unless the same value is changed in both the client and Edge Functions.

## 3. Verify before production

1. Use Cloudflare's documented test keys locally; do not weaken production
   validation for local development.
2. Create one court hold, one Open Play registration, one host-session
   registration, and one host application, then submit a receipt through each
   digital-payment path.
3. Confirm the browser shows a clear error when the Turnstile script is blocked.
4. Confirm a second server submission with the same token is rejected as
   expired/duplicate and does not create a Storage object or call Vision.
5. Confirm a valid token for a different action or hostname is rejected.
6. Confirm an active staff account bypasses, an owning host bypasses only their
   own row/session, and another host still needs a valid challenge.
7. Check the integration dashboard: receipt OCR is ready only when both
   `GOOGLE_VISION_API_KEY` and `TURNSTILE_SECRET_KEY` exist.
8. For saved-booking GCash testing, confirm a clean 90%+ scan inside the
   15-minute window returns the canonical confirmed/paid state, while an
   unreadable or mismatched scan remains pending for review.
9. Re-submit a reference already settled for another payment and confirm that
   it is the only GCash uncertainty that becomes a terminal rejection.

Do not proxy, cache, or self-host Cloudflare's API script. The client loads the
exact `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
URL, and the Content Security Policy permits only Cloudflare's challenge frame.

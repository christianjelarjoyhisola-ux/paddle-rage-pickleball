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
persisted court booking can auto-approve and claim a payment reference.

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

Do not proxy, cache, or self-host Cloudflare's API script. The client loads the
exact `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
URL, and the Content Security Policy permits only Cloudflare's challenge frame.

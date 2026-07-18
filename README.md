# Paddle Rage Pickleball

A standalone pickleball court booking and operations platform with public reservations, Open Play hosting, receipt verification, payments, admin reporting, and role-based access. Production is served at `https://paddleragecdo.ph` and uses a dedicated Supabase project.

Receipt OCR runs server-side through Google Cloud Vision behind Cloudflare Turnstile. Customer confirmation and reschedule messages use Maileroo from the verified `paddleragecdo.ph` sending domain; no provider secret is shipped to the browser.

## Brand system

- Primary logo: `paddleragelogo.jpg`
- Primary background: `#050706`
- Surface: `#0B0F0C`
- Neon green: `#B6F000`
- Bright accent: `#D7FF3F`
- Shared brand overrides: `brand-theme.css`

## Production deployment

1. Copy `.env.example` to the ignored `.env.local` and fill in Paddle Rage's deployment credentials. Never commit this file.
2. Review [GOOGLE_VISION_SETUP.md](GOOGLE_VISION_SETUP.md) and [TURNSTILE_SETUP.md](TURNSTILE_SETUP.md).
3. Run `npm test` and `npm run check`.
4. Run `deploy-edge-functions.ps1`; it applies migrations before publishing functions and fails closed when required remote integration secrets are missing.
5. Authenticate with `wrangler login` (or set a scoped `CLOUDFLARE_API_TOKEN`), then run `deploy-cloudflare-pages.ps1` to publish the static site and public Turnstile site key.
6. Verify the custom domain, Edge Function health, one receipt flow, and one delivered confirmation email after release.

## Local preview

Serve the folder over HTTP; do not open the HTML files directly. For example:

```powershell
npm run dev
```

Open `http://localhost:8788/?localData=1` to use isolated browser demo data without a Supabase connection.

## Checks

```powershell
npm test
npm run check
```

## Separation checklist

- Use a new Supabase organization/project and fresh admin accounts.
- Use a new Cloudflare Pages project, domain, analytics property, and AdSense account if ads are later enabled.
- Verify Paddle Rage's sending domain in Maileroo and use a new sending key, Telegram bot/chat, PayMongo keys, payment webhook secret, OCR key, and merchant QR images.
- Review all legal text, operating hours, prices, policies, location, payment instructions, and seeded demo content before production.
- Have qualified Philippine counsel review the included platform agreement and privacy/consumer terms before accepting real bookings.
- Do not copy `.env.local`, browser local storage, service-role keys, database exports, or deployment caches from another venue.

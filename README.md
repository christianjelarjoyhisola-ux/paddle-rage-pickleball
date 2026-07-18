# Paddle Rage Pickleball

A standalone pickleball court booking and operations platform with public reservations, Open Play hosting, receipt verification, payments, admin reporting, and role-based access.

The repository has been rebranded as an independent Paddle Rage system. It contains no source repository history or Git remote, and all copied live-service identifiers have been removed. The frontend is intentionally disconnected until a dedicated Supabase project is configured.

## Brand system

- Primary logo: `paddleragelogo.jpg`
- Primary background: `#050706`
- Surface: `#0B0F0C`
- Neon green: `#B6F000`
- Bright accent: `#D7FF3F`
- Shared brand overrides: `brand-theme.css`

## Safe first-time setup

1. Create a brand-new Supabase project owned by Paddle Rage.
2. Copy `.env.example` to `.env.local` and fill in only the new project values.
3. Run `SETUP_NEW_SUPABASE.sql` in the new Supabase SQL editor.
4. In `supabase-config.js`, replace `YOUR_PROJECT_REF` and `YOUR_SUPABASE_ANON_KEY` with the same new project's public values.
5. In `supabase/migrations/20260716120000_host_balance_deadlines.sql`, replace `YOUR_PROJECT_REF` before applying that migration so the scheduled job targets the new project.
6. Run `node create-accounts.js` to create fresh admin accounts. Never keep the example passwords.
7. Configure and deploy the Edge Functions with `deploy-edge-functions.ps1`.
8. Create a new Cloudflare Pages project and deploy with `deploy-cloudflare-pages.ps1`.
9. Enter Paddle Rage's own court, merchant, QR, location, pricing, and contact information in the admin dashboard before launch.

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
- Use new Resend/SMTP sender verification, Telegram bot/chat, PayMongo keys, payment webhook secret, OCR key, and merchant QR images.
- Review all legal text, operating hours, prices, policies, location, payment instructions, and seeded demo content before production.
- Have qualified Philippine counsel review the included platform agreement and privacy/consumer terms before accepting real bookings.
- Do not copy `.env.local`, browser local storage, service-role keys, database exports, or deployment caches from another venue.

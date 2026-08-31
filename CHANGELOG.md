# Changelog — Paddle Rage Pickleball

## 2026-08-31 — Paddle Rage Intelligence

- Added a premium owner/court-owner Insights workspace with actual 28-day booked capacity, evidence-gated fill forecasting, a responsive demand heatmap, court filtering, and one regular-price Court Pick recommendation.
- Kept Intelligence read-only: it never changes prices, bookings, payments, receipts, or customer data.
- Corrected Korte Dos analytics issues by using an explicit zero-history state, calculating expected total fill from existing reservations plus evidence-backed open-hour demand, excluding Open Play from private-court demand, and avoiding false “published” claims.
- Added a paginated, PII-minimal booking adapter plus Manila-time, payment-state, schedule-exclusion, role, branding, mobile, and forecast regression coverage.

## 2026-07-16 — Independent brand foundation

- Imported the booking platform as a clean code snapshot without source Git history or remote configuration.
- Replaced user-facing venue branding with Paddle Rage Pickleball across public, host, login, admin, database seed, and Edge Function content.
- Applied the supplied Paddle Rage logo to all page branding and favicon references.
- Added a centralized black and neon-green visual system with accessible high-contrast controls.
- Removed the previous live Supabase URL and anon key, production domain redirects, AdSense publisher, court photos, unrelated venue imagery, and legacy brand assets.
- Changed deployment defaults to a new `paddle-rage-pickleball` Cloudflare Pages project.
- Made email logo and admin URLs environment-driven and added an explicit configuration template.
- Added clean setup, separation, testing, and launch documentation.

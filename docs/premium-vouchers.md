# Premium vouchers

Owners manage campaigns at `/vouchers` after signing in through the admin dashboard. Court owners must first receive court funding permissions from the system owner on that page. Campaign creation requires acknowledging that the original booking fee remains payable by the court owner, including with a 100% discount.

Use reusable codes for public promotions and unique single-use batches for complimentary bookings. Set court, booking type, play schedule, redemption dates, budget through redemption limits, and optional customer limits before sharing codes. Campaign terms are immutable; pause an existing campaign and create a replacement to change terms. Pausing blocks new reservations but honors existing reservations.

Guests apply a code after entering contact details. Prices and eligibility come from the server. A zero-total checkout confirms without a receipt or payment session. Other bookings pay the discounted amount; host deposits include the customer-covered fee and 25% of the remaining court portion, subject to the existing full-payment deadline. Submitted payment evidence locks voucher changes.

The original booking fee is earned once on first confirmation. Complimentary bookings record no customer cash and use the `complimentary` payment status. Reports show voucher savings and owner-funded fee shortfalls; the existing remittance ledger includes the full original fee. Confirmed cancellations and no-shows retain voucher consumption and fee obligations. Use the existing audited fee-adjustment workflow for authorized corrections.

## Rollout and verification

1. Apply `20260922020000_premium_vouchers.sql`, initially disabled by `settings.vouchers_enabled = 0`.
2. Deploy `booking-vouchers` and `send-confirmation-email` Edge Functions.
3. Run `npm test`, `npm run check`, and `node tools/test-vouchers-db.cjs --deployed`. The database harness always rolls back its bookings, campaigns, and remittance statements.
4. Deploy the frontend using `deploy-cloudflare-pages.ps1`; verify owner access and mobile checkout.
5. Set `settings.vouchers_enabled = 1`. No campaigns or funding assignments are automatically created.

For an incident, set the flag back to `0` and pause affected campaigns. This blocks new voucher applications while honoring existing reserved/consumed vouchers. Keep the additive schema and backend installed so existing discounted bookings, confirmations, and remittances remain valid. Do not roll back the database or delete financial history.

The first release excludes Open Play registrations, prepaid gift credit, stacked codes, retrospective discounts, transfers of payment between voucher bookings, and automated marketing distribution.

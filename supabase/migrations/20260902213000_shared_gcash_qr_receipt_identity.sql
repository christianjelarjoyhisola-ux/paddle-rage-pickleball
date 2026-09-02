-- Share the authoritative GCash QR receipt identity across the independent
-- BDO Pay and BPI parsers. BDO exposes the complete destination token while
-- BPI masks it and exposes only the trailing suffix (for example, NS8).

begin;

insert into public.settings (key, value)
select
  'gcash_qr_receipt_recipient_name',
  coalesce(
    nullif((select value from public.settings where key = 'bdopay_receipt_recipient_name'), ''),
    nullif((select value from public.settings where key = 'bpi_receipt_recipient_name'), ''),
    'PaddleRage'
  )
on conflict (key) do nothing;

insert into public.settings (key, value)
select
  'gcash_qr_receipt_destination_token',
  coalesce(
    nullif((select value from public.settings where key = 'bdopay_receipt_destination_token'), ''),
    'DWQM4TK3JDO9O0NS8'
  )
on conflict (key) do nothing;

commit;

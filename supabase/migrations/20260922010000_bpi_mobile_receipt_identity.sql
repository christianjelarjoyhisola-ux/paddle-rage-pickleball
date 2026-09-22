-- Owner-approved BPI labels are bound to the complete destination number.
-- They are never sufficient on their own or for a masked QR destination.
begin;

insert into public.settings (key, value)
values (
  'bpi_receipt_mobile_recipient_aliases',
  '{"09455107667":["JKEM","Paddle Rage"]}'
)
on conflict (key) do nothing;

commit;

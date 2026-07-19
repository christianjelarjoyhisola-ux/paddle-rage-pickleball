-- Only approved host court reservations may use a partial reservation payment.
-- Customer court bookings and Open Play player registrations require 100%.

insert into public.settings (key, value)
values ('payment_acceptance_mode', 'full_payment_only')
on conflict (key) do update
set value = excluded.value;

create or replace function public.enforce_regular_booking_full_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.host_booking, false) = false then
    if lower(coalesce(new.payment_status, 'unpaid')) = 'downpayment_paid' then
      raise exception 'Only host court reservations can carry a balance.'
        using errcode = '23514';
    end if;
    new.downpayment := new.total;
    new.balance_due_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists a01_enforce_regular_booking_full_payment
  on public.bookings;
create trigger a01_enforce_regular_booking_full_payment
before insert or update of downpayment, payment_status, total, host_booking
on public.bookings
for each row execute function public.enforce_regular_booking_full_payment();

revoke all on function public.enforce_regular_booking_full_payment()
  from public, anon, authenticated;

comment on function public.enforce_regular_booking_full_payment() is
  'Requires full payment amounts for non-host bookings and prevents regular bookings from entering a balance-due state.';

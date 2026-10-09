begin;

-- The same four payment types shown in the owner's Payment Review queue.
-- Accepted deposits are excluded; their Payment 2 has its own pending row.
create or replace view public.payment_review_reminder_candidates as
select 'booking'::text as kind,
  coalesce(nullif(b.booking_group_ref, ''), b.ref) as subject_id,
  coalesce(nullif(b.booking_group_ref, ''), b.ref) as reference,
  sum(coalesce(nullif(b.downpayment, 0), b.total, 0)) as amount,
  max(coalesce(v.submitted_at, b.receipt_verified_at, b.created_at)) as pending_since
from public.bookings b
left join lateral (
  select max(r.created_at) as submitted_at from public.receipt_verifications r
  where r.booking_ref = b.ref and r.image_hash = b.receipt_image_hash
) v on true
where coalesce(b.email, '') <> 'reserve@hold.internal'
  and coalesce(b.payment_method, '') not in ('', 'cash')
  and b.payment_status not in ('paid', 'downpayment_paid', 'deposit_retained', 'rejected')
  and b.status not in ('cancelled', 'rejected', 'forfeited', 'expired', 'failed')
  and coalesce(b.receipt_status, '') <> 'rejected'
  and nullif(b.receipt_image_url, '') is not null
group by coalesce(nullif(b.booking_group_ref, ''), b.ref)
union all
select 'host_balance', p.id::text, p.booking_key, p.expected_amount, p.submitted_at
from public.host_booking_balance_payments p
where p.status = 'pending_review' and p.submitted_at is not null
union all
select 'open_play', p.id::text, 'OP-' || p.id::text, p.amount,
  coalesce(v.created_at, p.receipt_verified_at, p.created_at)
from public.open_play_registrations p
left join public.receipt_verifications v on v.id = p.receipt_verification_id
where p.payment_status not in ('paid', 'rejected', 'cancelled', 'refunded')
  and coalesce(p.receipt_status, '') <> 'rejected'
  and coalesce(p.payment_method, '') not in ('', 'cash')
  and (nullif(p.receipt_image_url, '') is not null or nullif(p.gcash_ref, '') is not null)
union all
select 'host_session', p.id::text, 'HOST-OP-' || p.id::text, p.amount,
  coalesce(v.created_at, p.receipt_verified_at, p.created_at)
from public.open_play_host_session_registrations p
left join public.receipt_verifications v on v.id = p.receipt_verification_id
where p.payment_status not in ('paid', 'downpayment_paid', 'rejected', 'cancelled', 'refunded')
  and coalesce(p.receipt_status, '') <> 'rejected'
  and coalesce(p.payment_method, '') not in ('', 'cash')
  and (nullif(p.receipt_image_url, '') is not null or nullif(p.gcash_ref, '') is not null);

revoke all on public.payment_review_reminder_candidates from public, anon, authenticated;
grant select on public.payment_review_reminder_candidates to service_role;

create table public.payment_review_reminder_deliveries (
  kind text not null,
  subject_id text not null,
  recipient_key text not null,
  lease_token uuid,
  next_attempt_at timestamptz not null default '-infinity',
  last_sent_at timestamptz,
  sent_count integer not null default 0,
  primary key (kind, subject_id, recipient_key)
);
alter table public.payment_review_reminder_deliveries enable row level security;
revoke all on public.payment_review_reminder_deliveries from public, anon, authenticated;
grant select on public.payment_review_reminder_deliveries to service_role;

create function public.due_payment_review_reminders(p_recipient_key text)
returns setof public.payment_review_reminder_candidates
language sql security definer set search_path = public, pg_temp as $$
  select c.* from public.payment_review_reminder_candidates c
  left join public.payment_review_reminder_deliveries d
    on (d.kind, d.subject_id, d.recipient_key) = (c.kind, c.subject_id, p_recipient_key)
  where c.pending_since <= now() - interval '1 hour'
    and coalesce(d.next_attempt_at, '-infinity'::timestamptz) <= now()
  order by coalesce(d.last_sent_at, c.pending_since), c.kind, c.subject_id limit 10
$$;

create function public.claim_payment_review_reminder(p_kind text, p_subject_id text, p_recipient_key text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare token uuid := gen_random_uuid(); claimed uuid;
begin
  if p_recipient_key !~ '^[a-f0-9]{64}$' then raise exception 'Invalid recipient key'; end if;
  if not exists (select 1 from public.payment_review_reminder_candidates
    where kind = p_kind and subject_id = p_subject_id and pending_since <= now() - interval '1 hour')
  then return null; end if;
  insert into public.payment_review_reminder_deliveries as d
    (kind, subject_id, recipient_key, lease_token, next_attempt_at)
  values (p_kind, p_subject_id, p_recipient_key, token, now() + interval '1 hour')
  on conflict (kind, subject_id, recipient_key) do update
    set lease_token = token, next_attempt_at = now() + interval '1 hour'
    where d.next_attempt_at <= now()
  returning lease_token into claimed;
  return claimed;
end $$;

create function public.finish_payment_review_reminder(
  p_kind text, p_subject_id text, p_recipient_key text, p_token uuid, p_sent boolean
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.payment_review_reminder_deliveries set
    lease_token = null,
    last_sent_at = case when p_sent then now() else last_sent_at end,
    sent_count = sent_count + case when p_sent then 1 else 0 end,
    next_attempt_at = now() + interval '1 hour'
  where kind = p_kind and subject_id = p_subject_id and recipient_key = p_recipient_key and lease_token = p_token;
  return found;
end $$;

revoke all on function public.due_payment_review_reminders(text) from public, anon, authenticated;
revoke all on function public.claim_payment_review_reminder(text,text,text) from public, anon, authenticated;
revoke all on function public.finish_payment_review_reminder(text,text,text,uuid,boolean) from public, anon, authenticated;
grant execute on function public.due_payment_review_reminders(text) to service_role;
grant execute on function public.claim_payment_review_reminder(text,text,text) to service_role;
grant execute on function public.finish_payment_review_reminder(text,text,text,uuid,boolean) to service_role;

commit;

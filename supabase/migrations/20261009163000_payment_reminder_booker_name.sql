begin;

-- Append the booker name without changing reminder timing or eligibility.
create or replace view public.payment_review_reminder_candidates as
select 'booking'::text as kind,
  coalesce(nullif(b.booking_group_ref, ''), b.ref) as subject_id,
  coalesce(nullif(b.booking_group_ref, ''), b.ref) as reference,
  sum(coalesce(nullif(b.downpayment, 0), b.total, 0)) as amount,
  max(coalesce(v.submitted_at, b.receipt_verified_at, b.created_at)) as pending_since,
  max(nullif(trim(b.full_name), '')) as booker_name
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
select 'host_balance', p.id::text, p.booking_key, p.expected_amount, p.submitted_at, nullif(trim(p.customer_name), '')
from public.host_booking_balance_payments p
where p.status = 'pending_review' and p.submitted_at is not null
union all
select 'open_play', p.id::text, 'OP-' || p.id::text, p.amount,
  coalesce(v.created_at, p.receipt_verified_at, p.created_at), nullif(trim(p.full_name), '')
from public.open_play_registrations p
left join public.receipt_verifications v on v.id = p.receipt_verification_id
where p.payment_status not in ('paid', 'rejected', 'cancelled', 'refunded')
  and coalesce(p.receipt_status, '') <> 'rejected'
  and coalesce(p.payment_method, '') not in ('', 'cash')
  and (nullif(p.receipt_image_url, '') is not null or nullif(p.gcash_ref, '') is not null)
union all
select 'host_session', p.id::text, 'HOST-OP-' || p.id::text, p.amount,
  coalesce(v.created_at, p.receipt_verified_at, p.created_at), nullif(trim(p.full_name), '')
from public.open_play_host_session_registrations p
left join public.receipt_verifications v on v.id = p.receipt_verification_id
where p.payment_status not in ('paid', 'downpayment_paid', 'rejected', 'cancelled', 'refunded')
  and coalesce(p.receipt_status, '') <> 'rejected'
  and coalesce(p.payment_method, '') not in ('', 'cash')
  and (nullif(p.receipt_image_url, '') is not null or nullif(p.gcash_ref, '') is not null);


commit;

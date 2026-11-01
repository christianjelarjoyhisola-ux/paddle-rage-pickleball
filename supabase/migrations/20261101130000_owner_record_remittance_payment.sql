-- ============================================================================
-- System owner records a remittance payment received directly
--
-- Court owners often pay the system owner outside the app. This lets the
-- system owner upload the receipt and accept it in one atomic step, using the
-- existing submit and review RPCs so every ledger rule still applies:
-- remaining-balance cap, duplicate reference/proof protection, proof path
-- ownership, settlement status, and the append-only audit events.
-- ============================================================================

begin;

create or replace function public.record_booking_fee_remittance_payment(
  p_remittance_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_payment_reference text,
  p_proof_path text,
  p_note text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  key_value text := trim(coalesce(p_idempotency_key, ''));
  payment public.booking_fee_remittance_payments%rowtype;
begin
  if public.current_account_role() is distinct from 'owner' then
    raise exception 'Only the active system owner may record a received remittance.'
      using errcode = '42501';
  end if;
  if length(key_value) not between 8 and 120 then
    raise exception 'A valid idempotency key is required.' using errcode = '22023';
  end if;

  perform public.submit_booking_fee_remittance(
    p_remittance_id,
    p_amount,
    p_payment_method,
    p_payment_reference,
    p_proof_path,
    p_note,
    key_value
  );

  select p.* into payment
    from public.booking_fee_remittance_payments p
   where p.submitted_by_user_id = auth.uid()
     and p.submission_idempotency_key = key_value
   limit 1;
  if payment.id is null then
    raise exception 'The recorded payment could not be found.' using errcode = 'P0002';
  end if;

  -- A retried request whose payment was already accepted returns as-is.
  if payment.status = 'pending' then
    perform public.review_booking_fee_remittance_payment(
      payment.id,
      'accept',
      payment.amount_submitted,
      'Recorded by the system owner as received directly.',
      key_value || '-accept'
    );
  end if;

  return public.get_booking_fee_remittance_detail(payment.remittance_id);
end;
$$;

revoke all on function public.record_booking_fee_remittance_payment(uuid, numeric, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_booking_fee_remittance_payment(uuid, numeric, text, text, text, text, text)
  to authenticated;

comment on function public.record_booking_fee_remittance_payment(uuid, numeric, text, text, text, text, text) is
  'System owner only: uploads proof for a payment received directly and accepts it atomically through the standard submit and review RPCs.';

notify pgrst, 'reload schema';

commit;

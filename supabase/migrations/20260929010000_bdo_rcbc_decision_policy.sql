-- BDO -> RCBC only: strict approval gate and atomic rejection of confirmed reuse.
begin;

-- Confirmation comes from the protected ledger, not a client-supplied flag.
create or replace function public.bdo_rcbc_duplicate_is_confirmed(e jsonb, flags text[], p_booking_ref text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare group_ref text; owner_key text; scope_key text;
begin
  if auth.role() is distinct from 'service_role' or coalesce(e->>'provider','')<>'rcbc'
     or coalesce(e#>>'{rcbc,layout}','')<>'bdo_bank'
     or coalesce(e#>>'{rcbc,sourceParserVersion}','')<>'bdo_to_rcbc_v1'
     or not (coalesce(flags,array[]::text[]) && array['DUPLICATE_REF','DUPLICATE_INVOICE']) then return false; end if;
  select nullif(b.booking_group_ref,'') into group_ref from public.bookings b where b.ref=p_booking_ref;
  owner_key:=coalesce(group_ref,p_booking_ref); scope_key:=case when group_ref is null then 'booking' else 'booking_group' end;
  return exists(select 1 from public.used_gcash_refs u where u.gcash_ref in (
    'rcbc:'||(e#>>'{rcbc,canonicalReference}'), 'bdopay:'||(e#>>'{rcbc,canonicalReference}'),
    'bdopay_invoice:'||(e#>>'{rcbc,invoiceReference}'))
    and case when nullif(u.claim_scope,'') is not null and nullif(u.claim_owner_id,'') is not null
      then not (u.claim_scope=scope_key and u.claim_owner_id=owner_key)
      else u.booking_ref is distinct from p_booking_ref and not exists(select 1 from public.bookings b where b.ref=u.booking_ref and group_ref is not null and b.booking_group_ref=group_ref) end);
end $$;
revoke all on function public.bdo_rcbc_duplicate_is_confirmed(jsonb,text[],text) from public,anon,authenticated;
grant execute on function public.bdo_rcbc_duplicate_is_confirmed(jsonb,text[],text) to service_role;
CREATE OR REPLACE FUNCTION public.assert_rcbc_auto_receipt(p_evidence jsonb, p_booking_ref text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare layout text:=p_evidence#>>'{rcbc,layout}'; item text; expected_key text; configured_name text; configured_number text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Only the receipt service may validate RCBC evidence' using errcode='42501'; end if;
  if not exists(select 1 from public.settings where key='rcbc_auto_verify_enabled' and value='1') then
    raise exception 'RCBC automatic verification is disabled' using errcode='23514';
  end if;
  select value into configured_name from public.settings where key='rcbc_merchant_name';
  select value into configured_number from public.settings where key='rcbc_merchant_number';
  if layout is null or layout not in ('gcash_bank','bpi_bank','maribank_bank','instapay_details','gotyme_bank','bdo_bank')
     or jsonb_typeof(p_evidence#>'{rcbc,references}') is distinct from 'array'
     or coalesce(p_evidence#>>'{bankTransfer,indicators,transferSuccess}','')<>'true'
     or (coalesce(p_evidence#>>'{bankTransfer,recipientComparison,name}','')<>'exact' and not (layout='gotyme_bank' and p_evidence#>>'{bankTransfer,recipientComparison,name}'='masked_compatible'))
     or coalesce(p_evidence#>>'{bankTransfer,recipientComparison,account}','') not in ('exact','suffix_exact')
     or coalesce(p_evidence->>'expectedReceiverNumber','') is distinct from configured_number
     or coalesce(p_evidence->>'expectedReceiverName','') is distinct from configured_name
     or (layout<>'bdo_bank' and coalesce(p_evidence#>>'{rcbc,destinationBank}','') !~* (case when layout='gotyme_bank' then '^Rizal Commercial Banking Corp[.]?[[:space:]]*[(]RCBC[)]$' else '^RCBC[[:space:]]*/[[:space:]]*DiskarTech$' end)) then
    raise exception 'RCBC recipient and receipt evidence is incomplete' using errcode='22023';
  end if;
  if jsonb_array_length(p_evidence#>'{rcbc,references}')=0
     or not ((p_evidence#>'{rcbc,references}') ? (p_evidence->>'ref'))
     or not ((p_evidence#>'{rcbc,references}') ? (p_evidence#>>'{rcbc,canonicalReference}')) then
    raise exception 'RCBC reference aliases are incomplete' using errcode='22023';
  end if;
  if layout='gotyme_bank' and (coalesce(p_evidence#>>'{rcbc,sourceParserVersion}','')<>'gotyme_to_rcbc_v1' or coalesce(p_evidence#>>'{rcbc,traceReference}','') !~ '^[0-9]{6}$') then
      raise exception 'GoTyme RCBC source evidence is incomplete' using errcode='22023';
    end if;
  if layout='bdo_bank' then
    if coalesce(p_evidence#>>'{rcbc,sourceParserVersion}','')<>'bdo_to_rcbc_v1'
       or coalesce(configured_number,'') !~ '^[0-9]{6}1901$'
       or coalesce(p_evidence#>>'{bankTransfer,recipient,accountRaw}','')<>'...1901'
       or upper(regexp_replace(coalesce(p_evidence#>>'{bankTransfer,recipient,nameRaw}',''),'[^a-zA-Z0-9]','','g'))<>upper(regexp_replace(configured_name,'[^a-zA-Z0-9]','','g'))
       or coalesce(p_evidence->>'date','')<>to_char(clock_timestamp() at time zone 'Asia/Manila','YYYY-MM-DD')
       or coalesce(p_evidence->>'receiptAgeMinutes','') !~ '^[0-9]+([.][0-9]+)?$'
       or (p_evidence->>'receiptAgeMinutes')::numeric > 15
       or coalesce(p_evidence#>>'{rcbc,invoiceReference}','') !~ '^[0-9]{6,12}$'
       or not exists(select 1 from jsonb_array_elements(p_evidence->'dedupeKeys') k where k->>'key'='bdopay_invoice:'||(p_evidence#>>'{rcbc,invoiceReference}'))
       or not exists(select 1 from jsonb_array_elements(p_evidence->'dedupeKeys') k where k->>'key'='bdopay:'||(p_evidence#>>'{rcbc,canonicalReference}')) then
      raise exception 'BDO RCBC approval requirements are incomplete' using errcode='22023';
    end if;
  end if;
  for item in select jsonb_array_elements_text(p_evidence#>'{rcbc,references}') loop
    if item !~ (case when layout='bdo_bank' then '^BN[0-9]{16}$' when layout='gotyme_bank' then '^ITO[0-9]{15}$' else '^[0-9]{6,20}$' end) then raise exception 'Invalid RCBC reference evidence' using errcode='22023'; end if;
    expected_key:=case when length(item)>=10 then 'rcbc:'||item else 'rcbc_'||layout||':'||(p_evidence->>'date')||':'||item end;
    if expected_key is null or not exists(select 1 from jsonb_array_elements(p_evidence->'dedupeKeys') k where k->>'key'=expected_key) then
      raise exception 'RCBC reference replay key is missing' using errcode='22023';
    end if;
    -- Respect receipts already claimed by the legacy owner-review-only release.
    if exists(select 1 from public.used_gcash_refs u where u.gcash_ref='rcbc:'||item
      and u.booking_ref is distinct from p_booking_ref
      and not exists(select 1 from public.bookings a join public.bookings b on a.booking_group_ref=b.booking_group_ref
        where a.ref=p_booking_ref and b.ref=u.booking_ref and a.booking_group_ref is not null)) then
      raise exception 'RCBC receipt was already used by another booking' using errcode='23505';
    end if;
  end loop;
end $function$
;
CREATE OR REPLACE FUNCTION public.finalize_digital_receipt_review(p_booking_ref text, p_booking_refs text[], p_lease_key text, p_lease_token uuid, p_provider text, p_payment_reference text, p_receipt_image_url text, p_receipt_image_hash text, p_receipt_phash text, p_receipt_flags text[], p_receipt_extracted jsonb, p_receipt_confidence numeric, p_receipt_verified_at timestamp with time zone, p_raw_ocr_text text)
 RETURNS TABLE(booking_ref text, booking_status text, booking_payment_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  provider_value text := lower(trim(coalesce(p_provider, '')));
  expected_parser_version text;
  normalized_reference text;
  target_booking public.bookings%rowtype;
  lease_row public.receipt_verification_leases%rowtype;
  actual_refs text[];
  expected_refs text[];
  observed_group_ref text;
  logical_booking_key text;
  invalid_rows integer;
  updated_count integer;
  review_extracted jsonb;
  reject_bdo_duplicate boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the receipt verification service may queue a review.'
      using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_booking_ref, '')), '') is null then
    raise exception 'Booking reference is required.' using errcode = '22023';
  end if;
  if provider_value not in ('gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'unionbank', 'rcbc') then
    raise exception 'This provider does not have a dedicated receipt reviewer.'
      using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_receipt_image_url, '')), '') is null
     or coalesce(p_receipt_image_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid private receipt checkpoint is required.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_receipt_extracted) <> 'object' then
    raise exception 'Structured parser evidence is required.'
      using errcode = '22023';
  end if;

  expected_parser_version := case provider_value
    when 'gcash' then 'gcash_v1'
    when 'bdopay' then 'bdopay_to_gcash_v1'
    when 'maya' then 'maya_to_gcash_v1'
    when 'bpi' then 'bpi_to_gcash_v1'
    when 'gotyme' then case when p_receipt_extracted->>'parserVersion'='gotyme_to_gcash_v2' then 'gotyme_to_gcash_v2' else 'gotyme_to_gcash_v1' end
    when 'maribank' then 'maribank_to_gcash_v1' when 'unionbank' then 'unionbank_to_gcash_v1' when 'rcbc' then 'rcbc_incoming_v1'
  end;
  if lower(coalesce(p_receipt_extracted->>'provider', '')) <> provider_value
     or coalesce(p_receipt_extracted->>'parserVersion', '') <>
          expected_parser_version
     or coalesce(p_receipt_extracted->>'verifierVersion', '') <>
          'receipt_evidence_v1' then
    raise exception 'Dedicated provider parser/verifier evidence is required.'
      using errcode = '22023';
  end if;
  if p_receipt_confidence is not null
     and (p_receipt_confidence < 0 or p_receipt_confidence > 1) then
    raise exception 'Receipt confidence is outside the valid range.'
      using errcode = '22023';
  end if;

  normalized_reference := public.normalize_payment_reference_key(
    provider_value,
    p_payment_reference
  );
  review_extracted := p_receipt_extracted || jsonb_build_object(
    'workflowResult', 'manual_review'
  );

  select nullif(trim(coalesce(b.booking_group_ref, '')), '')
    into observed_group_ref
    from public.bookings b
   where b.ref = p_booking_ref;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  logical_booking_key := coalesce(observed_group_ref, p_booking_ref);
  if trim(coalesce(p_lease_key, '')) <> logical_booking_key then
    raise exception 'Receipt verification lease does not match this booking.'
      using errcode = '40001';
  end if;

  if observed_group_ref is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'paddle-rage-public-booking-group:' || observed_group_ref,
        0
      )
    );
  end if;

  select leases.*
    into lease_row
    from public.receipt_verification_leases leases
   where leases.booking_key = logical_booking_key
   for update;
  if not found
     or lease_row.claim_token is distinct from p_lease_token
     or lease_row.lease_expires_at <= clock_timestamp() then
    raise exception 'Receipt verification lease is stale.'
      using errcode = '40001';
  end if;

  if observed_group_ref is null then
    select b.*
      into target_booking
      from public.bookings b
     where b.ref = p_booking_ref
     for update;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is not null then
      raise exception 'Booking scope changed during receipt verification.'
        using errcode = '40001';
    end if;
    actual_refs := array[p_booking_ref];
  else
    perform 1
      from public.bookings b
     where b.booking_group_ref = observed_group_ref
     order by b.ref
     for update;

    select b.*
      into target_booking
      from public.bookings b
     where b.ref = p_booking_ref;
    if not found
       or nullif(trim(coalesce(target_booking.booking_group_ref, '')), '')
         is distinct from observed_group_ref then
      raise exception 'Booking scope changed during receipt verification.'
        using errcode = '40001';
    end if;

    select array_agg(b.ref order by b.ref)
      into actual_refs
      from public.bookings b
     where b.booking_group_ref = observed_group_ref;
  end if;

  select array_agg(candidate order by candidate)
    into expected_refs
    from (
      select distinct unnest(coalesce(p_booking_refs, array[]::text[])) candidate
    ) refs;

  if actual_refs is null
     or expected_refs is null
     or actual_refs is distinct from expected_refs
     or not (p_booking_ref = any(actual_refs)) then
    raise exception 'Booking group changed during receipt verification.'
      using errcode = '40001';
  end if;

  select count(*)
    into invalid_rows
    from public.bookings b
   where b.ref = any(actual_refs)
     and (
       lower(trim(coalesce(b.payment_method, ''))) <> provider_value
       or public.normalize_payment_reference_key(
            provider_value,
            b.gcash_ref
          ) <> normalized_reference
       or lower(trim(coalesce(b.received_account, ''))) <> (case when provider_value='rcbc' then 'rcbc' else 'gcash' end)
       or b.status not in ('verifying', 'pending')
       or b.payment_status not in ('unpaid', 'pending', 'for_verification')
       or b.receipt_image_hash is distinct from p_receipt_image_hash
       or b.receipt_status <> 'manual_review'
     );
  if invalid_rows <> 0 then
    raise exception 'Booking payment state changed during receipt verification.'
      using errcode = '40001';
  end if;

  -- Only BDO -> RCBC may auto-reject. Recheck confirmed ledger ownership;
  -- a flag or lookup failure alone can never cancel a booking.
  if provider_value='rcbc'
     and p_receipt_extracted#>>'{rcbc,sourceParserVersion}'='bdo_to_rcbc_v1'
     and p_receipt_extracted#>>'{rcbc,layout}'='bdo_bank'
     and coalesce(p_receipt_flags,array[]::text[]) && array['DUPLICATE_REF','DUPLICATE_INVOICE'] then
    select exists(
      select 1 from public.used_gcash_refs u
      where u.gcash_ref in (
        'rcbc:'||(p_receipt_extracted#>>'{rcbc,canonicalReference}'),
        'bdopay:'||(p_receipt_extracted#>>'{rcbc,canonicalReference}'),
        'bdopay_invoice:'||(p_receipt_extracted#>>'{rcbc,invoiceReference}')
      ) and case when nullif(u.claim_scope,'') is not null and nullif(u.claim_owner_id,'') is not null
        then not (u.claim_scope=case when observed_group_ref is null then 'booking' else 'booking_group' end
                  and u.claim_owner_id=logical_booking_key)
        else not (u.booking_ref=any(actual_refs)) end
    ) into reject_bdo_duplicate;
  end if;
  if reject_bdo_duplicate then
    review_extracted := jsonb_set(review_extracted || jsonb_build_object('workflowResult','rejected'),'{verification,decision}','"rejected"'::jsonb);
  end if;

  update public.bookings b
     set status = case when reject_bdo_duplicate then 'cancelled' else 'pending' end,
         payment_status = case when reject_bdo_duplicate then 'rejected' else 'for_verification' end,
         receipt_image_url = p_receipt_image_url,
         receipt_image_hash = p_receipt_image_hash,
         receipt_phash = p_receipt_phash,
         receipt_status = case when reject_bdo_duplicate then 'rejected' else 'manual_review' end,
         receipt_flags = coalesce(p_receipt_flags, array[]::text[]),
         receipt_extracted = review_extracted,
         receipt_confidence = p_receipt_confidence,
         receipt_verified_at =
           coalesce(p_receipt_verified_at, clock_timestamp())
   where b.ref = any(actual_refs);

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(actual_refs) then
    raise exception 'Manual review did not update the complete booking group.'
      using errcode = '40001';
  end if;

  insert into public.receipt_verifications (
    booking_ref,
    result,
    flags,
    extracted,
    confidence,
    image_hash,
    phash,
    raw_ocr_text
  ) values (
    p_booking_ref,
    case when reject_bdo_duplicate then 'rejected' else 'manual_review' end,
    coalesce(p_receipt_flags, array[]::text[]),
    review_extracted,
    p_receipt_confidence,
    p_receipt_image_hash,
    p_receipt_phash,
    p_raw_ocr_text
  );

  delete from public.receipt_verification_leases leases
   where leases.booking_key = logical_booking_key
     and leases.claim_token = p_lease_token;
  if not found then
    raise exception 'Receipt verification lease changed before commit.'
      using errcode = '40001';
  end if;

  return query
  select b.ref, b.status, b.payment_status
    from public.bookings b
   where b.ref = any(actual_refs)
   order by b.ref;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.prevent_automatic_receipt_rejection()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.result='rejected' and public.bdo_rcbc_duplicate_is_confirmed(new.extracted,new.flags,new.booking_ref) then return new; end if;
  if lower(trim(coalesce(new.result, ''))) = 'rejected' then
    new.flags := public.automatic_rejection_review_flags(new.flags);
    new.extracted := case
      when jsonb_typeof(new.extracted) = 'object' then
        new.extracted || jsonb_build_object(
          'analysisResult', 'rejected',
          'workflowResult', 'manual_review'
        )
      else jsonb_build_object(
        'analysisResult', 'rejected',
        'workflowResult', 'manual_review'
      )
    end;
    new.result := 'manual_review';
  elsif lower(trim(coalesce(new.result, ''))) = 'auto_approved'
        and not coalesce(
          public.receipt_auto_approval_evidence_is_clean(
            new.result,
            new.flags,
            new.confidence,
            new.extracted
          ),
          false
        ) then
    new.flags := public.automatic_approval_review_flags(new.flags);
    new.extracted := case
      when jsonb_typeof(new.extracted) = 'object' then
        new.extracted || jsonb_build_object(
          'analysisResult', 'auto_approved',
          'workflowResult', 'manual_review'
        )
      else jsonb_build_object(
        'analysisResult', 'auto_approved',
        'workflowResult', 'manual_review'
      )
    end;
    new.result := 'manual_review';
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.prevent_automatic_booking_rejection()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  method_value text := lower(trim(coalesce(new.payment_method, 'cash')));
  actor_role text := public.current_account_role();
  digital_payment boolean := method_value in (
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'unionbank', 'pnb', 'rcbc'
  );
  active_submission boolean := tg_op = 'INSERT' or (
    old.status in ('verifying', 'pending')
    and old.payment_status in ('unpaid', 'pending', 'for_verification')
  );
  placeholder_hold boolean :=
    lower(trim(coalesce(new.email, ''))) = 'reserve@hold.internal'
    or lower(trim(coalesce(new.full_name, ''))) like 'reserving%';
begin
  if new.receipt_status='rejected' and public.bdo_rcbc_duplicate_is_confirmed(new.receipt_extracted,new.receipt_flags,new.ref) then return new; end if;
  if method_value in ('gotyme', 'maribank', 'unionbank') then
    new.received_account := 'gcash';
  end if;

  -- Placeholder rows use GCash only as an insert-time default. They do not
  -- represent a submitted payment and must be allowed to expire normally.
  if placeholder_hold then
    return new;
  end if;

  if digital_payment
     and active_submission
     and actor_role not in ('owner', 'court_owner')
     and (
       new.receipt_status = 'rejected'
       or new.payment_status = 'rejected'
     ) then
    new.status := 'pending';
    new.payment_status := 'for_verification';
    new.receipt_status := 'manual_review';
    new.receipt_flags := public.automatic_rejection_review_flags(
      new.receipt_flags
    );
    new.paid_at := case when tg_op = 'UPDATE' then old.paid_at else null end;
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.assert_host_booking_balance_receipt_audit(p_payment_id uuid, p_receipt_verification_id bigint)
 RETURNS receipt_verifications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_payment public.host_booking_balance_payments%rowtype;
  v_audit public.receipt_verifications%rowtype;
  v_expected_amount numeric;
  v_expected_total numeric;
  v_reference text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the balance payment service may validate an audit.'
      using errcode = '42501';
  end if;

  select * into v_payment
  from public.host_booking_balance_payments p
  where p.id = p_payment_id;
  if v_payment.id is null then
    raise exception 'Balance payment was not found.' using errcode = 'P0002';
  end if;

  select * into v_audit
  from public.receipt_verifications r
  where r.id = p_receipt_verification_id
    and r.booking_ref = v_payment.verification_ref;
  if v_audit.id is null then
    raise exception 'Receipt verification does not belong to this balance payment.'
      using errcode = '22023';
  end if;
  if v_audit.result not in ('auto_approved', 'manual_review', 'rejected')
     or nullif(btrim(coalesce(v_audit.image_hash, '')), '') is null
     or v_audit.created_at < v_payment.created_at - interval '5 seconds' then
    raise exception 'Receipt verification is incomplete or invalid.'
      using errcode = '22023';
  end if;
  if coalesce(v_audit.extracted->>'verificationContext', '') <>
       'host_booking_balance'
     or coalesce(v_audit.extracted->>'balancePaymentId', '') <>
       v_payment.id::text
     or lower(coalesce(v_audit.extracted->>'provider', '')) <>
       v_payment.payment_provider then
    raise exception 'Receipt verification context does not match this payment.'
      using errcode = '22023';
  end if;

  begin
    v_expected_amount := (v_audit.extracted->>'expectedAmount')::numeric;
    v_expected_total := (v_audit.extracted->>'expectedTotal')::numeric;
  exception when others then
    raise exception 'Receipt verification amount is missing or invalid.'
      using errcode = '22023';
  end;
  if abs(v_expected_amount - v_payment.expected_amount) > 0.01
     or abs(v_expected_total - v_payment.expected_amount) > 0.01 then
    raise exception 'Receipt verification amount does not match the balance due.'
      using errcode = '22023';
  end if;

  v_reference := public.normalize_host_balance_payment_reference(
    v_audit.extracted->>'submittedReference',
    v_payment.payment_provider
  );
  if v_reference <> v_payment.payment_reference then
    raise exception 'Receipt verification reference does not match this payment.'
      using errcode = '22023';
  end if;

  if v_audit.result='rejected' and public.bdo_rcbc_duplicate_is_confirmed(v_audit.extracted,v_audit.flags,v_audit.booking_ref) then return v_audit; end if;
  if v_audit.result = 'rejected' then
    v_audit.flags := public.automatic_rejection_review_flags(v_audit.flags);
    v_audit.extracted := case
      when jsonb_typeof(v_audit.extracted) = 'object' then
        v_audit.extracted || jsonb_build_object(
          'analysisResult', 'rejected',
          'workflowResult', 'manual_review'
        )
      else jsonb_build_object(
        'analysisResult', 'rejected',
        'workflowResult', 'manual_review'
      )
    end;
    v_audit.result := 'manual_review';
  elsif v_audit.result = 'auto_approved'
        and not coalesce(
          public.receipt_auto_approval_evidence_is_clean(
            v_audit.result,
            v_audit.flags,
            v_audit.confidence,
            v_audit.extracted
          ),
          false
        ) then
    v_audit.flags := public.automatic_approval_review_flags(v_audit.flags);
    v_audit.extracted := case
      when jsonb_typeof(v_audit.extracted) = 'object' then
        v_audit.extracted || jsonb_build_object(
          'analysisResult', 'auto_approved',
          'workflowResult', 'manual_review'
        )
      else jsonb_build_object(
        'analysisResult', 'auto_approved',
        'workflowResult', 'manual_review'
      )
    end;
    v_audit.result := 'manual_review';
  end if;

  if v_payment.payment_provider='rcbc' and v_audit.result='auto_approved' then perform public.assert_rcbc_auto_receipt(v_audit.extracted,v_audit.booking_ref); end if;
  return v_audit;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.guard_digital_payment_decision_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  method_value text := lower(trim(coalesce(new.payment_method, 'cash')));
  actor_role_value text := public.current_account_role();
  request_role_value text := coalesce(auth.role(), '');
  delegated_payment_id_text text := nullif(trim(coalesce(
    current_setting(
      'paddle_rage.host_balance_decision_payment_id',
      true
    ),
    ''
  )), '');
  delegated_actor_role text := lower(trim(coalesce(current_setting(
    'paddle_rage.host_balance_decision_actor_role',
    true
  ), '')));
  delegated_actor_user_id text := nullif(trim(coalesce(current_setting(
    'paddle_rage.host_balance_decision_actor_user_id',
    true
  ), '')), '');
  delegated_payment_id uuid;
  host_balance_decision_allowed boolean := false;
begin
  if method_value not in (
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'unionbank', 'pnb', 'rcbc'
  ) or old.payment_status is not distinct from new.payment_status then
    return new;
  end if;

  if lower(trim(coalesce(new.payment_status, ''))) not in (
    'paid', 'downpayment_paid', 'rejected'
  ) then
    return new;
  end if;

  if actor_role_value in ('owner', 'court_owner') and auth.uid() is not null then
    return new;
  end if;

  if request_role_value = 'service_role'
     and tg_table_name = 'bookings'
     and delegated_payment_id_text is not null then
    begin
      delegated_payment_id := delegated_payment_id_text::uuid;
    exception when invalid_text_representation then
      delegated_payment_id := null;
    end;

    if delegated_payment_id is not null then
      select exists (
        select 1
          from public.host_booking_balance_payments payment
         where payment.id = delegated_payment_id
           and new.ref = any(payment.booking_refs)
           and payment.status = 'pending_review'
           and payment.receipt_verification_id is not null
           and (
             (
               delegated_actor_role = 'system'
               and delegated_actor_user_id is null
               and public.receipt_auto_approval_evidence_is_clean(
                 payment.receipt_result,
                 payment.receipt_flags,
                 payment.receipt_confidence,
                 payment.receipt_extracted
               )
             )
             or (
               delegated_actor_role in ('owner', 'court_owner')
               and delegated_actor_user_id is not null
               and exists (
                 select 1
                   from public.accounts reviewer
                  where reviewer.id::text = delegated_actor_user_id
                    and reviewer.status = 'active'
                    and reviewer.role = delegated_actor_role
               )
             )
           )
      ) into host_balance_decision_allowed;
    end if;
  end if;

  if host_balance_decision_allowed then
    return new;
  end if;

  if request_role_value = 'service_role'
     and lower(trim(coalesce(new.payment_status, ''))) in (
       'paid', 'downpayment_paid'
     )
     and lower(trim(coalesce(new.receipt_status, ''))) = 'auto_approved'
     and cardinality(coalesce(new.receipt_flags, array[]::text[])) = 0 then
    return new;
  end if;

  if request_role_value='service_role' and tg_table_name='bookings'
     and new.payment_status='rejected' and new.receipt_status='rejected' then
    if public.bdo_rcbc_duplicate_is_confirmed(new.receipt_extracted,new.receipt_flags,new.ref) then return new; end if;
  end if;

  raise exception 'Only an active owner or court owner can resolve a pending digital payment.'
    using errcode = '42501';
end;
$function$
;
commit;

-- MariBank support and provider-neutral receipt settlement.
--
-- Clean, complete receipt evidence may settle atomically. Any parser/verifier
-- rejection is advisory only and is converted to manual_review; only an
-- authenticated owner or court owner may deliberately reject a payment.
-- Historical auto-approved/rejected/cancelled rows remain unchanged.

begin;

insert into public.settings (key, value)
values
  ('payment_method_gotyme', '1'),
  ('payment_method_maribank', '1')
on conflict (key) do update
  set value = excluded.value;

alter table public.open_play_host_session_registrations
  drop constraint if exists open_play_host_session_registrations_payment_method_check;
alter table public.open_play_host_session_registrations
  add constraint open_play_host_session_registrations_payment_method_check
  check (payment_method in (
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb', 'cash'
  ));

alter table public.host_booking_balance_payments
  drop constraint if exists host_booking_balance_payments_provider_check;
alter table public.host_booking_balance_payments
  add constraint host_booking_balance_payments_provider_check
  check (payment_provider in (
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'
  ));

create or replace function public.normalize_payment_reference_key(
  p_provider text,
  p_typed_reference text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  provider_value text := lower(trim(coalesce(p_provider, '')));
  normalized_value text;
begin
  if provider_value = 'cash' then
    return null;
  end if;
  if provider_value not in (
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'
  ) then
    raise exception 'Unsupported digital payment provider.'
      using errcode = '22023';
  end if;

  normalized_value := case
    when provider_value = 'gcash' then
      regexp_replace(coalesce(p_typed_reference, ''), '[^0-9]', '', 'g')
    else
      upper(regexp_replace(
        coalesce(p_typed_reference, ''),
        '[^A-Za-z0-9]',
        '',
        'g'
      ))
  end;

  if normalized_value = '' then
    raise exception 'A payment reference is required before confirming payment.'
      using errcode = '22023';
  end if;
  if provider_value = 'gcash' and normalized_value !~ '^[0-9]{13}$' then
    raise exception 'The GCash reference must contain exactly 13 digits.'
      using errcode = '22023';
  elsif provider_value = 'bdopay' and normalized_value !~ '^BN[0-9]{16}$' then
    raise exception 'The BDO Pay reference is invalid.'
      using errcode = '22023';
  elsif provider_value = 'maya' and normalized_value !~ '^[A-Z0-9]{12}$' then
    raise exception 'The Maya reference is invalid.'
      using errcode = '22023';
  elsif provider_value = 'bpi' and normalized_value !~ '^[0-9]{10,20}$' then
    raise exception 'The BPI confirmation number is invalid.'
      using errcode = '22023';
  end if;

  return case
    when provider_value = 'gcash' then normalized_value
    else provider_value || ':' || normalized_value
  end;
end;
$$;

-- GoTyme and MariBank are source applications that send to the configured
-- GCash recipient, just like the existing BDO Pay/Maya/BPI routes.
create or replace function public.public_payment_method_ready(p_method text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  method_value text := lower(trim(coalesce(p_method, '')));
  method_enabled boolean;
  has_recipient_name boolean;
  has_destination boolean;
begin
  select trim(coalesce(s.value, '')) = '1'
    into method_enabled
    from public.settings s
   where s.key = 'payment_method_' || method_value
   limit 1;

  if not coalesce(method_enabled, false) then
    return false;
  end if;
  if method_value = 'cash' then
    return true;
  end if;

  if method_value in ('gotyme', 'maribank') then
    select exists (
      select 1
        from public.settings s
       where s.key = 'gcash_merchant_name'
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_recipient_name;
    select exists (
      select 1
        from public.settings s
       where s.key = any(array['gcash_merchant_number', 'gcash_qr_image'])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_destination;
  elsif method_value in ('gcash', 'bdopay', 'maya', 'bpi') then
    select exists (
      select 1
        from public.settings s
       where s.key = any(array[
         method_value || '_merchant_name',
         'payment_merchant_name',
         'gcash_merchant_name'
       ])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_recipient_name;
    select exists (
      select 1
        from public.settings s
       where s.key = any(array[
         method_value || '_merchant_number',
         method_value || '_qr_image',
         'gcash_merchant_number',
         'gcash_qr_image'
       ])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_destination;
  elsif method_value = 'pnb' then
    select exists (
      select 1
        from public.settings s
       where s.key = 'pnb_merchant_name'
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_recipient_name;
    select exists (
      select 1
        from public.settings s
       where s.key = any(array['pnb_merchant_number', 'pnb_qr_image'])
         and nullif(trim(coalesce(s.value, '')), '') is not null
    ) into has_destination;
  else
    return false;
  end if;

  return coalesce(has_recipient_name, false)
     and coalesce(has_destination, false);
end;
$$;

revoke all on function public.public_payment_method_ready(text)
  from public, anon, authenticated;
grant execute on function public.public_payment_method_ready(text)
  to service_role;

-- Patch only the closed provider lists in the existing mature transactions.
-- Their locking, amount checks, duplicate claims, and idempotency remain the
-- source of truth. Abort if migration history does not match expectations.
do $provider_patch$
declare
  function_signature text;
  function_oid regprocedure;
  original_definition text;
  patched_definition text;
begin
  foreach function_signature in array array[
    'public.prepare_public_booking_insert()',
    'public.update_public_booking_hold(text,text,jsonb)',
    'public.prepare_public_open_play_registration()',
    'public.prepare_public_host_session_registration()',
    'public.confirm_booking_transaction(text)',
    'public.payment_review_ledger_keys(jsonb,text,text)',
    'public.create_host_booking_balance_payment(text,uuid,text,text,text)'
  ]
  loop
    function_oid := to_regprocedure(function_signature);
    if function_oid is null then
      raise exception 'Required payment function % was not found.',
        function_signature using errcode = '42883';
    end if;

    select pg_get_functiondef(function_oid)
      into original_definition;
    patched_definition := replace(
      original_definition,
      '''gotyme'', ''pnb''',
      '''gotyme'', ''maribank'', ''pnb'''
    );
    if patched_definition = original_definition then
      raise exception 'Provider list in % did not match the expected definition.',
        function_signature using errcode = 'P0001';
    end if;
    execute patched_definition;
  end loop;
end;
$provider_patch$;

-- Analyzer outcomes are evidence for deliberate owner review, not terminal
-- payment decisions. Remove the legacy label-based blocks from the mature
-- confirmation transaction. Its authoritative booking/reference checks stay
-- intact, and the all-evidence-key trigger below adds the provider-rail claim.
do $manual_review_confirm_patch$
declare
  function_oid regprocedure :=
    to_regprocedure('public.confirm_booking_transaction(text)');
  original_definition text;
  patched_definition text;
  guard_message text;
  marker_position integer;
  preceding_text text;
  reverse_if_offset integer;
  block_start integer;
  following_text text;
  end_if_offset integer;
  block_end integer;
begin
  if function_oid is null then
    raise exception 'Required booking confirmation function was not found.'
      using errcode = '42883';
  end if;

  select pg_get_functiondef(function_oid)
    into original_definition;
  patched_definition := original_definition;

  -- pg_get_functiondef preserves function semantics but may normalize
  -- whitespace differently across PostgreSQL/Supabase versions. Locate each
  -- unique analyzer-only exception and remove its enclosing IF block without
  -- depending on indentation or line wrapping. Abort unless both guards are
  -- present and structurally complete.
  foreach guard_message in array array[
    'The receipt is rejected and cannot be confirmed.',
    'The receipt contains proven duplicate evidence and cannot be confirmed.'
  ]
  loop
    marker_position := strpos(patched_definition, guard_message);
    if marker_position = 0 then
      raise exception 'Booking confirmation analyzer guard was not found: %',
        guard_message using errcode = 'P0001';
    end if;

    preceding_text := substring(
      patched_definition from 1 for marker_position - 1
    );
    reverse_if_offset := strpos(
      reverse(preceding_text),
      reverse('if exists (')
    );
    if reverse_if_offset = 0 then
      raise exception 'Booking confirmation analyzer guard has no IF start: %',
        guard_message using errcode = 'P0001';
    end if;
    block_start := marker_position
      - reverse_if_offset
      - char_length('if exists (')
      + 1;

    following_text := substring(patched_definition from marker_position);
    end_if_offset := strpos(following_text, 'end if;');
    if end_if_offset = 0 then
      raise exception 'Booking confirmation analyzer guard has no IF end: %',
        guard_message using errcode = 'P0001';
    end if;
    block_end := marker_position
      + end_if_offset
      + char_length('end if;')
      - 2;

    patched_definition := substring(
      patched_definition from 1 for block_start - 1
    ) || E'\n' || substring(patched_definition from block_end + 1);
  end loop;

  if patched_definition = original_definition then
    raise exception 'Booking confirmation analyzer guards were not removed.'
      using errcode = 'P0001';
  end if;

  execute patched_definition;
end;
$manual_review_confirm_patch$;

-- The balance-review RPC is service-role-only and validates the real reviewer
-- (or clean system audit) before it mutates the booking rows. Pass that exact
-- payment identity through transaction-local settings so the generic booking
-- payment guard can distinguish this authorized Payment 2 transition from an
-- unrelated service-role write. The guard below revalidates every field.
do $host_balance_decision_context_patch$
declare
  function_oid regprocedure := to_regprocedure(
    'public.apply_host_booking_balance_payment_decision(uuid,text,uuid,text,text)'
  );
  original_definition text;
  patched_definition text;
  update_needle text := E'  update public.bookings b\n     set payment_status = ''paid'',\n         downpayment = b.total';
  update_replacement text := E'  perform set_config(\n    ''paddle_rage.host_balance_decision_payment_id'',\n    v_payment.id::text,\n    true\n  );\n  perform set_config(\n    ''paddle_rage.host_balance_decision_actor_role'',\n    v_actor_role,\n    true\n  );\n  perform set_config(\n    ''paddle_rage.host_balance_decision_actor_user_id'',\n    coalesce(p_actor_user_id::text, ''''),\n    true\n  );\n\n  update public.bookings b\n     set payment_status = ''paid'',\n         downpayment = b.total';
begin
  if function_oid is null then
    raise exception 'Required host-balance decision function was not found.'
      using errcode = '42883';
  end if;

  select pg_get_functiondef(function_oid)
    into original_definition;
  patched_definition := replace(
    original_definition,
    update_needle,
    update_replacement
  );
  if patched_definition = original_definition then
    raise exception 'Host-balance decision update did not match the expected definition.'
      using errcode = 'P0001';
  end if;
  execute patched_definition;
end;
$host_balance_decision_context_patch$;

create or replace function public.automatic_rejection_review_flags(
  p_flags text[]
)
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  result_flags text[] := coalesce(p_flags, array[]::text[]);
begin
  if not ('AUTO_REJECTION_SUPPRESSED' = any(result_flags)) then
    result_flags := array_append(result_flags, 'AUTO_REJECTION_SUPPRESSED');
  end if;
  return result_flags;
end;
$$;

create or replace function public.automatic_approval_review_flags(
  p_flags text[]
)
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  result_flags text[] := coalesce(p_flags, array[]::text[]);
begin
  if not ('AUTO_APPROVAL_EVIDENCE_INVALID' = any(result_flags)) then
    result_flags := array_append(
      result_flags,
      'AUTO_APPROVAL_EVIDENCE_INVALID'
    );
  end if;
  return result_flags;
end;
$$;

-- Keep this predicate provider-neutral: dedicated provider parsers emit the
-- same verifier contract. A contradictory decision/boolean can never become
-- an automatic financial settlement even if a caller labels it auto_approved.
create or replace function public.receipt_auto_approval_evidence_is_clean(
  p_result text,
  p_flags text[],
  p_confidence numeric,
  p_extracted jsonb
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    lower(trim(coalesce(p_result, ''))) = 'auto_approved'
    and cardinality(coalesce(p_flags, array[]::text[])) = 0
    and p_confidence is not null
    and p_confidence >= 0.90
    and p_confidence <= 1
    and jsonb_typeof(p_extracted) = 'object'
    and lower(coalesce(
      p_extracted#>>'{verification,decision}',
      ''
    )) = 'valid'
    and coalesce(
      p_extracted#>>'{verification,sourceProviderMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,referenceMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,amountMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,timestampValid}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,recipientMatch}',
      ''
    ) = 'true'
    and coalesce(
      p_extracted#>>'{verification,duplicateClear}',
      ''
    ) = 'true'
    and lower(coalesce(
      p_extracted#>>'{verification,destinationProvider}',
      ''
    )) = 'gcash';
$$;

revoke all on function public.automatic_approval_review_flags(text[])
  from public, anon, authenticated;
revoke all on function public.receipt_auto_approval_evidence_is_clean(
  text, text[], numeric, jsonb
) from public, anon, authenticated;

-- Parser/verifier rejection remains visible in extracted.analysisResult and
-- flags, but its workflow result is always manual_review. A claimed automatic
-- approval is also routed to review unless every clean-evidence invariant is
-- true. Deliberate manual decisions are not modified.
create or replace function public.prevent_automatic_receipt_rejection()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
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
$$;

drop trigger if exists a00_prevent_automatic_receipt_rejection
  on public.receipt_verifications;
create trigger a00_prevent_automatic_receipt_rejection
before insert on public.receipt_verifications
for each row execute function public.prevent_automatic_receipt_rejection();

-- The host-balance RPC predates the provider-neutral verifier contract. This
-- forward override normalizes both unsafe claimed approvals and historical
-- rejected audits when they are consumed. The immutable audit is retained;
-- only the workflow row returned to the payment state machine is normalized.
-- That lets an authorized owner deliberately Confirm Received or Not Received
-- while keeping every automated rejection/cancellation path closed.
create or replace function public.assert_host_booking_balance_receipt_audit(
  p_payment_id uuid,
  p_receipt_verification_id bigint
)
returns public.receipt_verifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  return v_audit;
end;
$$;

revoke all on function public.assert_host_booking_balance_receipt_audit(
  uuid, bigint
) from public, anon, authenticated;
grant execute on function public.assert_host_booking_balance_receipt_audit(
  uuid, bigint
) to service_role;

-- This trigger runs before the existing z90 reference-claim trigger. It only
-- suppresses an automated/public rejection; clean auto-approval and an
-- authenticated owner/court-owner decision continue normally.
create or replace function public.prevent_automatic_booking_rejection()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  method_value text := lower(trim(coalesce(new.payment_method, 'cash')));
  actor_role text := public.current_account_role();
  digital_payment boolean := method_value in (
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'
  );
  active_submission boolean := tg_op = 'INSERT' or (
    old.status in ('verifying', 'pending')
    and old.payment_status in ('unpaid', 'pending', 'for_verification')
  );
begin
  if method_value in ('gotyme', 'maribank') then
    new.received_account := 'gcash';
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
$$;

drop trigger if exists y80_prevent_automatic_booking_rejection
  on public.bookings;
create trigger y80_prevent_automatic_booking_rejection
before insert or update of
  status,
  payment_status,
  payment_method,
  received_account,
  paid_at,
  receipt_status,
  receipt_flags
on public.bookings
for each row execute function public.prevent_automatic_booking_rejection();

-- Run before the existing public canonicalizer so a rejected client pre-check
-- cannot skip serialized capacity accounting, and again late in BEFORE order
-- to catch direct service-role writes. Owner/court-owner Not Received remains
-- authorized and releases capacity normally.
create or replace function public.prevent_automatic_registration_rejection()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  method_value text := lower(trim(coalesce(new.payment_method, 'cash')));
  actor_role text := public.current_account_role();
begin
  if method_value = 'cash' then
    return new;
  end if;

  if actor_role not in ('owner', 'court_owner')
     and (
       lower(coalesce(new.receipt_status, 'none')) = 'rejected'
       or lower(coalesce(new.payment_status, 'pending')) = 'rejected'
     ) then
    new.payment_status := 'pending';
    new.receipt_status := 'manual_review';
    new.receipt_flags := public.automatic_rejection_review_flags(
      new.receipt_flags
    );
  end if;
  return new;
end;
$$;

drop trigger if exists a00_00_queue_rejected_open_play_receipt
  on public.open_play_registrations;
create trigger a00_00_queue_rejected_open_play_receipt
before insert on public.open_play_registrations
for each row execute function public.prevent_automatic_registration_rejection();

drop trigger if exists y80_prevent_automatic_open_play_rejection
  on public.open_play_registrations;
create trigger y80_prevent_automatic_open_play_rejection
before insert or update of payment_status, payment_method, receipt_status, receipt_flags
on public.open_play_registrations
for each row execute function public.prevent_automatic_registration_rejection();

drop trigger if exists a00_00_queue_rejected_host_session_receipt
  on public.open_play_host_session_registrations;
create trigger a00_00_queue_rejected_host_session_receipt
before insert on public.open_play_host_session_registrations
for each row execute function public.prevent_automatic_registration_rejection();

drop trigger if exists y80_prevent_automatic_host_session_rejection
  on public.open_play_host_session_registrations;
create trigger y80_prevent_automatic_host_session_rejection
before insert or update of payment_status, payment_method, receipt_status, receipt_flags
on public.open_play_host_session_registrations
for each row execute function public.prevent_automatic_registration_rejection();

-- Dashboard RLS intentionally permits staff and owning hosts to edit selected
-- non-payment fields. A payment decision is narrower: only an authenticated
-- owner/court owner may resolve a pending digital payment. The protected
-- verifier service may perform only a clean auto-approval, never a rejection.
create or replace function public.guard_digital_payment_decision_role()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'
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

  raise exception 'Only an active owner or court owner can resolve a pending digital payment.'
    using errcode = '42501';
end;
$$;

drop trigger if exists y90_guard_booking_payment_decision_role
  on public.bookings;
create trigger y90_guard_booking_payment_decision_role
before update of payment_status, payment_method, receipt_status, receipt_flags
on public.bookings
for each row execute function public.guard_digital_payment_decision_role();

drop trigger if exists y90_guard_open_play_payment_decision_role
  on public.open_play_registrations;
create trigger y90_guard_open_play_payment_decision_role
before update of payment_status, payment_method, receipt_status, receipt_flags
on public.open_play_registrations
for each row execute function public.guard_digital_payment_decision_role();

drop trigger if exists y90_guard_host_session_payment_decision_role
  on public.open_play_host_session_registrations;
create trigger y90_guard_host_session_payment_decision_role
before update of payment_status, payment_method, receipt_status, receipt_flags
on public.open_play_host_session_registrations
for each row execute function public.guard_digital_payment_decision_role();

-- Compatibility guard for a receipt audit created before the audit trigger was
-- installed. The old submit transaction labels automated rejections as system;
-- owner/court-owner decisions remain untouched.
create or replace function public.prevent_automatic_host_balance_rejection()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status in ('created', 'pending_review')
     and new.status = 'rejected'
     and lower(coalesce(new.reviewed_by_role, 'system')) = 'system' then
    new.status := 'pending_review';
    new.receipt_result := 'manual_review';
    new.receipt_flags := public.automatic_rejection_review_flags(
      new.receipt_flags
    );
    new.reviewed_at := null;
    new.reviewed_by_user_id := null;
    new.reviewed_by_role := null;
    new.review_reason := null;
    new.rejected_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists y80_prevent_automatic_host_balance_rejection
  on public.host_booking_balance_payments;
create trigger y80_prevent_automatic_host_balance_rejection
before update of
  status,
  receipt_result,
  receipt_flags,
  reviewed_at,
  reviewed_by_user_id,
  reviewed_by_role,
  review_reason,
  rejected_at
on public.host_booking_balance_payments
for each row execute function public.prevent_automatic_host_balance_rejection();

-- Claim every provider and payment-rail replay key emitted by the dedicated
-- verifier. This closes the cross-provider race where two bank receipts have
-- different app references but share one `instapay:` rail reference.
create or replace function public.claim_verified_receipt_evidence_keys(
  p_extracted jsonb,
  p_fallback_provider text,
  p_fallback_reference text,
  p_claim_scope text,
  p_claim_owner_id text,
  p_owner_display_ref text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  provider_value text := lower(trim(coalesce(p_fallback_provider, '')));
  scope_value text := lower(trim(coalesce(p_claim_scope, '')));
  owner_value text := nullif(trim(coalesce(p_claim_owner_id, '')), '');
  display_value text := nullif(trim(coalesce(p_owner_display_ref, '')), '');
  primary_key text;
  evidence_key record;
  incumbent_scope text;
  incumbent_owner text;
  claimed_count integer := 0;
  primary_seen boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the receipt verification service may claim evidence keys.'
      using errcode = '42501';
  end if;
  if jsonb_typeof(p_extracted->'dedupeKeys') <> 'array'
     or jsonb_array_length(p_extracted->'dedupeKeys') = 0 then
    raise exception 'Receipt verifier did not emit dedupeKeys evidence.'
      using errcode = '22023';
  end if;
  if scope_value not in ('booking', 'booking_group', 'open_play', 'host_session')
     or owner_value is null
     or display_value is null then
    raise exception 'Receipt-evidence claim ownership is invalid.'
      using errcode = '22023';
  end if;

  primary_key := public.normalize_payment_reference_key(
    provider_value,
    p_fallback_reference
  );

  for evidence_key in
    select *
      from public.payment_review_ledger_keys(
        p_extracted,
        provider_value,
        p_fallback_reference
      )
  loop
    if nullif(trim(coalesce(evidence_key.ledger_key, '')), '') is null
       or length(evidence_key.ledger_key) > 240
       or nullif(trim(coalesce(evidence_key.provider_key, '')), '') is null
       or length(evidence_key.provider_key) > 80 then
      raise exception 'Receipt verifier emitted an invalid replay key.'
        using errcode = '22023';
    end if;

    insert into public.used_gcash_refs (
      gcash_ref,
      booking_ref,
      provider,
      claim_scope,
      claim_owner_id
    ) values (
      evidence_key.ledger_key,
      display_value,
      evidence_key.provider_key,
      scope_value,
      owner_value
    )
    on conflict (gcash_ref) do nothing;

    select ledger.claim_scope, ledger.claim_owner_id
      into incumbent_scope, incumbent_owner
      from public.used_gcash_refs ledger
     where ledger.gcash_ref = evidence_key.ledger_key;
    if incumbent_scope is distinct from scope_value
       or incumbent_owner is distinct from owner_value then
      raise exception 'This receipt or payment-rail reference was already used.'
        using errcode = '23505';
    end if;

    claimed_count := claimed_count + 1;
    primary_seen := primary_seen or evidence_key.ledger_key = primary_key;
  end loop;

  if claimed_count = 0 or not primary_seen then
    raise exception 'Receipt verifier did not emit the canonical provider reference.'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.claim_verified_receipt_evidence_keys(
  jsonb, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.claim_verified_receipt_evidence_keys(
  jsonb, text, text, text, text, text
) to service_role;

-- An owner may deliberately accept analyzer-flagged evidence, but the same
-- transaction must still prove that every real provider/payment-rail key is
-- unclaimed or already belongs to this logical booking. Any collision raises
-- 23505 before settlement and rolls the complete booking update back.
create or replace function public.claim_owner_confirmed_receipt_evidence()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role_value text := public.current_account_role();
  provider_value text := lower(trim(coalesce(new.payment_method, '')));
  claim_scope_value text;
  claim_owner_value text;
  evidence_key record;
  incumbent_scope text;
  incumbent_owner text;
begin
  if auth.uid() is null
     or actor_role_value not in ('owner', 'court_owner')
     or provider_value not in (
       'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'
     )
     or lower(trim(coalesce(new.payment_status, ''))) not in (
       'paid', 'downpayment_paid'
     )
     or lower(trim(coalesce(old.payment_status, ''))) in (
       'paid', 'downpayment_paid'
     ) then
    return new;
  end if;

  claim_scope_value := case
    when nullif(trim(coalesce(new.booking_group_ref, '')), '') is null
      then 'booking'
    else 'booking_group'
  end;
  claim_owner_value := coalesce(
    nullif(trim(coalesce(new.booking_group_ref, '')), ''),
    new.ref
  );

  -- Always claim the typed provider reference, even when older/mismatched OCR
  -- evidence did not emit a complete dedupeKeys array.
  perform public.claim_payment_reference(
    provider_value,
    new.gcash_ref,
    claim_scope_value,
    claim_owner_value,
    new.ref
  );

  for evidence_key in
    select distinct keys.ledger_key, keys.provider_key
      from public.payment_review_ledger_keys(
        coalesce(new.receipt_extracted, '{}'::jsonb),
        provider_value,
        new.gcash_ref
      ) keys
  loop
    if nullif(trim(coalesce(evidence_key.ledger_key, '')), '') is null
       or length(evidence_key.ledger_key) > 240
       or nullif(trim(coalesce(evidence_key.provider_key, '')), '') is null
       or length(evidence_key.provider_key) > 80 then
      raise exception 'Receipt verifier emitted an invalid replay key.'
        using errcode = '22023';
    end if;

    insert into public.used_gcash_refs (
      gcash_ref,
      booking_ref,
      provider,
      claim_scope,
      claim_owner_id
    ) values (
      evidence_key.ledger_key,
      new.ref,
      evidence_key.provider_key,
      claim_scope_value,
      claim_owner_value
    )
    on conflict (gcash_ref) do nothing;

    select ledger.claim_scope, ledger.claim_owner_id
      into incumbent_scope, incumbent_owner
      from public.used_gcash_refs ledger
     where ledger.gcash_ref = evidence_key.ledger_key;
    if incumbent_scope is distinct from claim_scope_value
       or incumbent_owner is distinct from claim_owner_value then
      raise exception 'This receipt or payment-rail reference is already linked to another payment.'
        using errcode = '23505';
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function public.claim_owner_confirmed_receipt_evidence()
  from public, anon, authenticated;

drop trigger if exists y95_claim_owner_confirmed_receipt_evidence
  on public.bookings;
create trigger y95_claim_owner_confirmed_receipt_evidence
before update of payment_status on public.bookings
for each row execute function public.claim_owner_confirmed_receipt_evidence();

-- Provider-neutral clean-receipt finalizer. Provider parsers remain separate,
-- but they must all emit this small verified-evidence contract. The database
-- then independently rechecks booking scope, reference, amount, receiver route,
-- receipt checkpoint, duplicate ownership, and verification lease in the same
-- transaction that settles the booking.
create or replace function public.finalize_digital_receipt_auto_approval(
  p_booking_ref text,
  p_booking_refs text[],
  p_lease_key text,
  p_lease_token uuid,
  p_provider text,
  p_payment_reference text,
  p_payment_status text,
  p_receipt_image_url text,
  p_receipt_image_hash text,
  p_receipt_phash text,
  p_receipt_flags text[],
  p_receipt_extracted jsonb,
  p_receipt_confidence numeric,
  p_receipt_verified_at timestamptz,
  p_raw_ocr_text text
)
returns table (
  booking_ref text,
  booking_status text,
  booking_payment_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  provider_value text := lower(trim(coalesce(p_provider, '')));
  expected_route text;
  expected_parser_version text;
  normalized_reference text;
  extracted_reference text;
  target_booking public.bookings%rowtype;
  lease_row public.receipt_verification_leases%rowtype;
  actual_refs text[];
  expected_refs text[];
  observed_group_ref text;
  logical_booking_key text;
  invalid_rows integer;
  updated_count integer;
  non_host_rows integer;
  paid_amount numeric;
  expected_total numeric;
  expected_due numeric;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the receipt verification service may auto-approve a payment.'
      using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_booking_ref, '')), '') is null then
    raise exception 'Booking reference is required.' using errcode = '22023';
  end if;
  if provider_value not in ('gcash', 'gotyme', 'maribank') then
    raise exception 'This provider does not have an approved automatic verifier.'
      using errcode = '22023';
  end if;
  if not public.public_payment_method_ready(provider_value) then
    raise exception 'This payment method is not currently enabled.'
      using errcode = '23514';
  end if;
  if coalesce(p_receipt_image_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid checkpoint image hash is required.'
      using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_receipt_image_url, '')), '') is null then
    raise exception 'A private receipt image path is required.'
      using errcode = '22023';
  end if;
  if p_payment_status not in ('paid', 'downpayment_paid') then
    raise exception 'Invalid automatic payment status.' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_receipt_flags, array[]::text[])) <> 0 then
    raise exception 'Flagged receipt evidence requires manual review.'
      using errcode = '22023';
  end if;
  if p_receipt_confidence is null
     or p_receipt_confidence < 0.90
     or p_receipt_confidence > 1 then
    raise exception 'High-confidence receipt evidence is required.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_receipt_extracted) <> 'object' then
    raise exception 'Structured receipt evidence is required.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_receipt_extracted->'dedupeKeys') <> 'array'
     or jsonb_array_length(p_receipt_extracted->'dedupeKeys') = 0 then
    raise exception 'Clean receipt evidence must include dedupeKeys.'
      using errcode = '22023';
  end if;

  expected_route := case provider_value
    when 'gcash' then 'gcash'
    when 'gotyme' then 'gotyme_to_gcash'
    when 'maribank' then 'maribank_to_gcash'
  end;
  expected_parser_version := case provider_value
    when 'gcash' then 'gcash_v1'
    when 'gotyme' then 'gotyme_to_gcash_v1'
    when 'maribank' then 'maribank_to_gcash_v1'
  end;
  if lower(coalesce(p_receipt_extracted->>'provider', '')) <> provider_value
     or coalesce(p_receipt_extracted->>'parserVersion', '') <>
          expected_parser_version
     or coalesce(p_receipt_extracted->>'verifierVersion', '') <>
          'receipt_evidence_v1'
     or lower(coalesce(p_receipt_extracted->>'route', '')) <> expected_route
     or lower(coalesce(
       p_receipt_extracted#>>'{verification,decision}',
       ''
     )) <> 'valid'
     or coalesce(
       p_receipt_extracted#>>'{verification,sourceProviderMatch}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,referenceMatch}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,amountMatch}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,timestampValid}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,recipientMatch}',
       ''
     ) <> 'true'
     or coalesce(
       p_receipt_extracted#>>'{verification,duplicateClear}',
       ''
     ) <> 'true'
     or lower(coalesce(
       p_receipt_extracted#>>'{verification,destinationProvider}',
       ''
     )) <> 'gcash' then
    raise exception 'Receipt verifier evidence is incomplete or requires review.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted->>'autoPaymentStatus', '') <>
       p_payment_status then
    raise exception 'Automatic payment classification changed.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted->>'amount', '')
       !~ '^[0-9]+([.][0-9]+)?$' then
    raise exception 'A reliable parsed receipt amount is required.'
      using errcode = '22023';
  end if;
  if coalesce(p_receipt_extracted->>'receiptAgeMinutes', '')
       !~ '^-?[0-9]+([.][0-9]+)?$'
     or (p_receipt_extracted->>'receiptAgeMinutes')::numeric < -2
     or (p_receipt_extracted->>'receiptAgeMinutes')::numeric > 15 then
    raise exception 'Receipt timestamp is outside the payment window.'
      using errcode = '22023';
  end if;

  normalized_reference := public.normalize_payment_reference_key(
    provider_value,
    p_payment_reference
  );
  extracted_reference := public.normalize_payment_reference_key(
    provider_value,
    p_receipt_extracted->>'ref'
  );
  if extracted_reference is distinct from normalized_reference then
    raise exception 'Parsed and submitted payment references do not match.'
      using errcode = '22023';
  end if;
  paid_amount := (p_receipt_extracted->>'amount')::numeric;

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

  select
    count(*) filter (
      where lower(trim(coalesce(b.payment_method, ''))) <> provider_value
         or public.normalize_payment_reference_key(
              provider_value,
              b.gcash_ref
            ) <> normalized_reference
         or lower(trim(coalesce(b.received_account, ''))) <> 'gcash'
         or b.status not in ('verifying', 'pending')
         or b.payment_status not in ('unpaid', 'pending', 'for_verification')
         or b.total is null
         or b.total <= 0
         or b.downpayment is null
         or b.downpayment <= 0
         or b.downpayment > b.total + 0.01
         or b.receipt_image_hash is distinct from p_receipt_image_hash
         or b.receipt_status <> 'manual_review'
    ),
    count(*) filter (where b.host_booking is distinct from true),
    round(coalesce(sum(b.total), 0)::numeric, 2),
    round(coalesce(sum(b.downpayment), 0)::numeric, 2)
    into invalid_rows, non_host_rows, expected_total, expected_due
    from public.bookings b
   where b.ref = any(actual_refs);

  if invalid_rows <> 0 then
    raise exception 'Booking payment state changed during receipt verification.'
      using errcode = '40001';
  end if;
  if expected_total <= 0
     or expected_due <= 0
     or expected_due > expected_total + 0.01 then
    raise exception 'Stored booking payment amounts require manual review.'
      using errcode = '22023';
  end if;

  if p_payment_status = 'paid' then
    if abs(expected_due - expected_total) > 0.01
       or abs(paid_amount - expected_total) > 0.01 then
      raise exception 'Parsed amount does not match the full booking total.'
        using errcode = '22023';
    end if;
  else
    if non_host_rows <> 0
       or expected_due >= expected_total - 0.01
       or abs(paid_amount - expected_due) > 0.01 then
      raise exception 'Parsed amount does not match the host amount due.'
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
      from public.bookings other_booking
     where not (other_booking.ref = any(actual_refs))
       and lower(trim(coalesce(other_booking.payment_method, ''))) =
           provider_value
       and nullif(trim(coalesce(other_booking.gcash_ref, '')), '') is not null
       and public.normalize_payment_reference_key(
             provider_value,
             other_booking.gcash_ref
           ) = normalized_reference
  ) then
    raise exception 'This payment reference is attached to another booking.'
      using errcode = '23505';
  end if;

  perform public.claim_verified_receipt_evidence_keys(
    p_receipt_extracted,
    provider_value,
    p_payment_reference,
    case when observed_group_ref is null then 'booking' else 'booking_group' end,
    logical_booking_key,
    p_booking_ref
  );

  update public.bookings b
     set status = 'confirmed',
         payment_status = p_payment_status,
         paid_at = coalesce(p_receipt_verified_at, clock_timestamp()),
         receipt_image_url = p_receipt_image_url,
         receipt_image_hash = p_receipt_image_hash,
         receipt_phash = p_receipt_phash,
         receipt_status = 'auto_approved',
         receipt_flags = array[]::text[],
         receipt_extracted = p_receipt_extracted,
         receipt_confidence = p_receipt_confidence,
         receipt_verified_at =
           coalesce(p_receipt_verified_at, clock_timestamp())
   where b.ref = any(actual_refs);

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(actual_refs) then
    raise exception 'Automatic settlement did not update the complete booking group.'
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
    'auto_approved',
    array[]::text[],
    p_receipt_extracted,
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
$$;

revoke all on function public.finalize_digital_receipt_auto_approval(
  text, text[], text, uuid, text, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.finalize_digital_receipt_auto_approval(
  text, text[], text, uuid, text, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) to service_role;

comment on function public.finalize_digital_receipt_auto_approval(
  text, text[], text, uuid, text, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) is
  'Atomically settles a clean GCash, GoTyme-to-GCash, or MariBank-to-GCash receipt. Any flag or failed evidence assertion must use manual review instead.';

-- Provider-neutral manual-review finalizer. It uses the same lease and group
-- fencing as auto-approval, but deliberately makes no positive conclusion
-- about amount, recipient, timestamp, duplicates, or OCR confidence. Those
-- concerns stay as evidence for the owner and can never cancel the booking.
create or replace function public.finalize_digital_receipt_review(
  p_booking_ref text,
  p_booking_refs text[],
  p_lease_key text,
  p_lease_token uuid,
  p_provider text,
  p_payment_reference text,
  p_receipt_image_url text,
  p_receipt_image_hash text,
  p_receipt_phash text,
  p_receipt_flags text[],
  p_receipt_extracted jsonb,
  p_receipt_confidence numeric,
  p_receipt_verified_at timestamptz,
  p_raw_ocr_text text
)
returns table (
  booking_ref text,
  booking_status text,
  booking_payment_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the receipt verification service may queue a review.'
      using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_booking_ref, '')), '') is null then
    raise exception 'Booking reference is required.' using errcode = '22023';
  end if;
  if provider_value not in ('gcash', 'gotyme', 'maribank') then
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
    when 'gotyme' then 'gotyme_to_gcash_v1'
    when 'maribank' then 'maribank_to_gcash_v1'
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
       or lower(trim(coalesce(b.received_account, ''))) <> 'gcash'
       or b.status not in ('verifying', 'pending')
       or b.payment_status not in ('unpaid', 'pending', 'for_verification')
       or b.receipt_image_hash is distinct from p_receipt_image_hash
       or b.receipt_status <> 'manual_review'
     );
  if invalid_rows <> 0 then
    raise exception 'Booking payment state changed during receipt verification.'
      using errcode = '40001';
  end if;

  update public.bookings b
     set status = 'pending',
         payment_status = 'for_verification',
         receipt_image_url = p_receipt_image_url,
         receipt_image_hash = p_receipt_image_hash,
         receipt_phash = p_receipt_phash,
         receipt_status = 'manual_review',
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
    'manual_review',
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
$$;

revoke all on function public.finalize_digital_receipt_review(
  text, text[], text, uuid, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.finalize_digital_receipt_review(
  text, text[], text, uuid, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) to service_role;

comment on function public.finalize_digital_receipt_review(
  text, text[], text, uuid, text, text, text, text, text, text[], jsonb,
  numeric, timestamptz, text
) is
  'Atomically preserves flagged or uncertain dedicated-provider evidence as pending manual review. It never rejects or cancels.';

-- Pre-save Open Play verification needs an immutable server-side binding;
-- browser-supplied receipt_status is never sufficient for auto-approval.
alter table public.open_play_registrations
  add column if not exists receipt_verification_id bigint
    references public.receipt_verifications(id) on delete restrict;
alter table public.open_play_host_session_registrations
  add column if not exists receipt_verification_id bigint
    references public.receipt_verifications(id) on delete restrict;

create unique index if not exists open_play_registrations_receipt_verification_uq
  on public.open_play_registrations(receipt_verification_id)
  where receipt_verification_id is not null;
create unique index if not exists host_session_registrations_receipt_verification_uq
  on public.open_play_host_session_registrations(receipt_verification_id)
  where receipt_verification_id is not null;

create table if not exists public.receipt_verification_subject_claims (
  receipt_verification_id bigint primary key
    references public.receipt_verifications(id) on delete restrict,
  subject_scope text not null,
  subject_id text not null,
  created_at timestamptz not null default now(),
  constraint receipt_verification_subject_claims_scope_check
    check (subject_scope in ('open_play', 'host_session'))
);

alter table public.receipt_verification_subject_claims enable row level security;
revoke all on table public.receipt_verification_subject_claims
  from public, anon, authenticated;
grant all on table public.receipt_verification_subject_claims to service_role;

create or replace function public.assert_clean_registration_receipt(
  p_receipt_verification_id bigint,
  p_provider text,
  p_payment_reference text,
  p_context text,
  p_expected_amount numeric,
  p_receipt_image_url text,
  p_customer_name text,
  p_booking_date date,
  p_subject_id text,
  p_subject_hour integer
)
returns public.receipt_verifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  audit_row public.receipt_verifications%rowtype;
  provider_value text := lower(trim(coalesce(p_provider, '')));
  context_value text := lower(trim(coalesce(p_context, '')));
  expected_route text;
  expected_parser_version text;
  normalized_reference text;
  extracted_reference text;
  parsed_amount numeric;
  extracted_expected_amount numeric;
  customer_name_key text := lower(regexp_replace(
    trim(coalesce(p_customer_name, '')),
    '[[:space:]]+',
    ' ',
    'g'
  ));
  extracted_customer_name_key text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the registration service may validate a receipt audit.'
      using errcode = '42501';
  end if;
  if provider_value not in ('gcash', 'gotyme', 'maribank')
     or context_value not in ('open_play', 'host_session') then
    raise exception 'This provider or registration context cannot auto-approve.'
      using errcode = '22023';
  end if;
  if not public.public_payment_method_ready(provider_value) then
    raise exception 'This payment method is not currently enabled.'
      using errcode = '23514';
  end if;
  if p_expected_amount is null or p_expected_amount <= 0 then
    raise exception 'A positive server-authoritative amount is required.'
      using errcode = '22023';
  end if;
  if customer_name_key = ''
     or p_booking_date is null
     or nullif(trim(coalesce(p_subject_id, '')), '') is null then
    raise exception 'Registration subject binding is incomplete.'
      using errcode = '22023';
  end if;

  select verification.*
    into audit_row
    from public.receipt_verifications verification
   where verification.id = p_receipt_verification_id
   for share;
  if not found then
    raise exception 'Receipt verification was not found.' using errcode = 'P0002';
  end if;
  if audit_row.result <> 'auto_approved'
     or cardinality(coalesce(audit_row.flags, array[]::text[])) <> 0
     or audit_row.confidence is null
     or audit_row.confidence < 0.90
     or audit_row.confidence > 1
     or coalesce(audit_row.image_hash, '') !~ '^[0-9a-f]{64}$'
     or audit_row.created_at < clock_timestamp() - interval '20 minutes'
     or jsonb_typeof(audit_row.extracted) <> 'object' then
    raise exception 'Receipt evidence is not eligible for automatic approval.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(audit_row.extracted->'dedupeKeys') <> 'array'
     or jsonb_array_length(audit_row.extracted->'dedupeKeys') = 0 then
    raise exception 'Clean receipt evidence must include dedupeKeys.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(audit_row.extracted->'subject') <> 'object' then
    raise exception 'Clean receipt evidence must include a subject binding.'
      using errcode = '22023';
  end if;

  extracted_customer_name_key := lower(regexp_replace(
    trim(coalesce(audit_row.extracted#>>'{subject,fullName}', '')),
    '[[:space:]]+',
    ' ',
    'g'
  ));
  if extracted_customer_name_key <> customer_name_key
     or coalesce(audit_row.extracted#>>'{subject,bookingDate}', '') <>
          p_booking_date::text
     or (
       context_value = 'open_play'
       and (
         coalesce(audit_row.extracted#>>'{subject,courtId}', '') <>
           p_subject_id
         or coalesce(audit_row.extracted#>>'{subject,hour}', '')
           !~ '^[0-9]+$'
         or (audit_row.extracted#>>'{subject,hour}')::integer is distinct from
           p_subject_hour
       )
     )
     or (
       context_value = 'host_session'
       and coalesce(audit_row.extracted#>>'{subject,sessionId}', '') <>
         p_subject_id
     ) then
    raise exception 'Receipt audit does not belong to this customer or session.'
      using errcode = '22023';
  end if;

  expected_route := case provider_value
    when 'gcash' then 'gcash'
    when 'gotyme' then 'gotyme_to_gcash'
    when 'maribank' then 'maribank_to_gcash'
  end;
  expected_parser_version := case provider_value
    when 'gcash' then 'gcash_v1'
    when 'gotyme' then 'gotyme_to_gcash_v1'
    when 'maribank' then 'maribank_to_gcash_v1'
  end;
  if lower(coalesce(audit_row.extracted->>'provider', '')) <> provider_value
     or lower(coalesce(
       audit_row.extracted->>'verificationContext',
       ''
     )) <> context_value
     or coalesce(audit_row.extracted->>'parserVersion', '') <>
          expected_parser_version
     or coalesce(audit_row.extracted->>'verifierVersion', '') <>
          'receipt_evidence_v1'
     or lower(coalesce(audit_row.extracted->>'route', '')) <> expected_route
     or lower(coalesce(
       audit_row.extracted#>>'{verification,decision}',
       ''
     )) <> 'valid'
     or coalesce(
       audit_row.extracted#>>'{verification,sourceProviderMatch}',
       ''
     ) <> 'true'
     or coalesce(
       audit_row.extracted#>>'{verification,referenceMatch}',
       ''
     ) <> 'true'
     or coalesce(
       audit_row.extracted#>>'{verification,amountMatch}',
       ''
     ) <> 'true'
     or coalesce(
       audit_row.extracted#>>'{verification,timestampValid}',
       ''
     ) <> 'true'
     or coalesce(
       audit_row.extracted#>>'{verification,recipientMatch}',
       ''
     ) <> 'true'
     or coalesce(
       audit_row.extracted#>>'{verification,duplicateClear}',
       ''
     ) <> 'true'
     or lower(coalesce(
       audit_row.extracted#>>'{verification,destinationProvider}',
       ''
     )) <> 'gcash'
     or coalesce(audit_row.extracted->>'receiptAgeMinutes', '')
       !~ '^-?[0-9]+([.][0-9]+)?$'
     or (audit_row.extracted->>'receiptAgeMinutes')::numeric < -2
     or (audit_row.extracted->>'receiptAgeMinutes')::numeric > 15 then
    raise exception 'Receipt verifier evidence is incomplete or requires review.'
      using errcode = '22023';
  end if;

  normalized_reference := public.normalize_payment_reference_key(
    provider_value,
    p_payment_reference
  );
  extracted_reference := public.normalize_payment_reference_key(
    provider_value,
    audit_row.extracted->>'ref'
  );
  if normalized_reference is distinct from extracted_reference then
    raise exception 'Parsed and submitted payment references do not match.'
      using errcode = '22023';
  end if;

  begin
    parsed_amount := (audit_row.extracted->>'amount')::numeric;
    extracted_expected_amount :=
      (audit_row.extracted->>'expectedAmount')::numeric;
  exception when others then
    raise exception 'Receipt amount evidence is missing or invalid.'
      using errcode = '22023';
  end;
  if abs(parsed_amount - p_expected_amount) > 0.01
     or abs(extracted_expected_amount - p_expected_amount) > 0.01 then
    raise exception 'Receipt amount does not match the registration amount.'
      using errcode = '22023';
  end if;

  if lower(coalesce(p_receipt_image_url, '')) !~
       ('/' || audit_row.image_hash || '[.](jpg|jpeg|png|webp)$') then
    raise exception 'Receipt audit does not match the uploaded image.'
      using errcode = '22023';
  end if;

  return audit_row;
end;
$$;

revoke all on function public.assert_clean_registration_receipt(
  bigint, text, text, text, numeric, text, text, date, text, integer
) from public, anon, authenticated;
grant execute on function public.assert_clean_registration_receipt(
  bigint, text, text, text, numeric, text, text, date, text, integer
) to service_role;

create or replace function public.submit_verified_public_open_play_registration(
  p_full_name text,
  p_court_id text,
  p_date date,
  p_hour integer,
  p_payment_type text,
  p_payment_method text,
  p_gcash_ref text,
  p_receipt_image_url text,
  p_receipt_verification_id bigint
)
returns table (
  id bigint,
  court_id text,
  court_name text,
  date date,
  hour integer,
  time_label text,
  payment_type text,
  payment_method text,
  payment_status text,
  amount numeric,
  receipt_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  registration_id bigint;
  registration_row public.open_play_registrations%rowtype;
  audit_row public.receipt_verifications%rowtype;
  claim_row public.receipt_verification_subject_claims%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Verified registration must pass through the protected service.'
      using errcode = '42501';
  end if;
  if p_receipt_verification_id is null then
    raise exception 'A clean receipt verification ID is required.'
      using errcode = '22023';
  end if;

  -- The audit ID is the idempotency key. This lock makes simultaneous retries
  -- serialize before either can consume capacity or claim payment evidence.
  perform pg_advisory_xact_lock(hashtextextended(
    'paddle-rage-receipt-registration:' || p_receipt_verification_id::text,
    0
  ));
  select claims.*
    into claim_row
    from public.receipt_verification_subject_claims claims
   where claims.receipt_verification_id = p_receipt_verification_id;
  if found then
    if claim_row.subject_scope <> 'open_play'
       or claim_row.subject_id !~ '^[0-9]+$' then
      raise exception 'Receipt verification is already bound to another registration.'
        using errcode = '23505';
    end if;

    registration_id := claim_row.subject_id::bigint;
    select *
      into registration_row
      from public.open_play_registrations registration
     where registration.id = registration_id
     for share;
    if not found
       or registration_row.receipt_verification_id is distinct from
            p_receipt_verification_id
       or registration_row.payment_status <> 'paid'
       or registration_row.receipt_status <> 'auto_approved'
       or cardinality(coalesce(
            registration_row.receipt_flags,
            array[]::text[]
          )) <> 0
       or lower(regexp_replace(
            trim(coalesce(registration_row.full_name, '')),
            '[[:space:]]+',
            ' ',
            'g'
          )) <> lower(regexp_replace(
            trim(coalesce(p_full_name, '')),
            '[[:space:]]+',
            ' ',
            'g'
          ))
       or registration_row.court_id is distinct from trim(p_court_id)
       or registration_row.date is distinct from p_date
       or registration_row.hour is distinct from p_hour
       or lower(trim(coalesce(registration_row.payment_type, ''))) <>
            lower(trim(coalesce(p_payment_type, '')))
       or lower(trim(coalesce(registration_row.payment_method, ''))) <>
            lower(trim(coalesce(p_payment_method, '')))
       or public.normalize_payment_reference_key(
            registration_row.payment_method,
            registration_row.gcash_ref
          ) is distinct from public.normalize_payment_reference_key(
            p_payment_method,
            p_gcash_ref
          )
       or registration_row.receipt_image_url is distinct from
            trim(p_receipt_image_url) then
      raise exception 'Receipt verification retry does not match its original registration.'
        using errcode = '23505';
    end if;

    return query
    select
      registration_row.id,
      registration_row.court_id,
      registration_row.court_name,
      registration_row.date,
      registration_row.hour,
      registration_row.time_label,
      registration_row.payment_type,
      registration_row.payment_method,
      registration_row.payment_status,
      registration_row.amount,
      registration_row.receipt_status,
      registration_row.created_at;
    return;
  end if;

  select submitted.id
    into registration_id
    from public.submit_public_open_play_registration(
      p_full_name,
      p_court_id,
      p_date,
      p_hour,
      p_payment_type,
      p_payment_method,
      p_gcash_ref,
      p_receipt_image_url,
      'manual_review'
    ) submitted;

  select *
    into registration_row
    from public.open_play_registrations registration
   where registration.id = registration_id
   for update;

  audit_row := public.assert_clean_registration_receipt(
    p_receipt_verification_id,
    registration_row.payment_method,
    registration_row.gcash_ref,
    'open_play',
    registration_row.amount,
    registration_row.receipt_image_url,
    registration_row.full_name,
    registration_row.date,
    registration_row.court_id,
    registration_row.hour
  );

  insert into public.receipt_verification_subject_claims (
    receipt_verification_id,
    subject_scope,
    subject_id
  ) values (
    audit_row.id,
    'open_play',
    registration_row.id::text
  );

  perform public.claim_verified_receipt_evidence_keys(
    audit_row.extracted,
    registration_row.payment_method,
    registration_row.gcash_ref,
    'open_play',
    registration_row.id::text,
    'op:' || registration_row.id::text
  );

  update public.open_play_registrations registration
     set payment_status = 'paid',
         receipt_status = 'auto_approved',
         receipt_flags = array[]::text[],
         receipt_extracted = audit_row.extracted,
         receipt_confidence = audit_row.confidence,
         receipt_image_hash = audit_row.image_hash,
         receipt_phash = audit_row.phash,
         receipt_verified_at = audit_row.created_at,
         receipt_verification_id = audit_row.id
   where registration.id = registration_row.id
     and registration.payment_status = 'pending'
     and registration.receipt_status = 'manual_review'
  returning * into registration_row;
  if not found then
    raise exception 'Registration changed before receipt approval.'
      using errcode = '40001';
  end if;

  return query
  select
    registration_row.id,
    registration_row.court_id,
    registration_row.court_name,
    registration_row.date,
    registration_row.hour,
    registration_row.time_label,
    registration_row.payment_type,
    registration_row.payment_method,
    registration_row.payment_status,
    registration_row.amount,
    registration_row.receipt_status,
    registration_row.created_at;
end;
$$;

revoke all on function public.submit_verified_public_open_play_registration(
  text, text, date, integer, text, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.submit_verified_public_open_play_registration(
  text, text, date, integer, text, text, text, text, bigint
) to service_role;

create or replace function public.submit_verified_public_host_session_registration(
  p_session_id uuid,
  p_full_name text,
  p_contact_number text,
  p_payment_method text,
  p_gcash_ref text,
  p_receipt_image_url text,
  p_receipt_verification_id bigint
)
returns table (
  id uuid,
  session_id uuid,
  payment_status text,
  amount numeric,
  receipt_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  registration_id uuid;
  registration_row public.open_play_host_session_registrations%rowtype;
  audit_row public.receipt_verifications%rowtype;
  claim_row public.receipt_verification_subject_claims%rowtype;
  session_date date;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Verified registration must pass through the protected service.'
      using errcode = '42501';
  end if;
  if p_receipt_verification_id is null then
    raise exception 'A clean receipt verification ID is required.'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'paddle-rage-receipt-registration:' || p_receipt_verification_id::text,
    0
  ));
  select claims.*
    into claim_row
    from public.receipt_verification_subject_claims claims
   where claims.receipt_verification_id = p_receipt_verification_id;
  if found then
    if claim_row.subject_scope <> 'host_session' then
      raise exception 'Receipt verification is already bound to another registration.'
        using errcode = '23505';
    end if;
    begin
      registration_id := claim_row.subject_id::uuid;
    exception when invalid_text_representation then
      raise exception 'Receipt verification has an invalid registration binding.'
        using errcode = '23505';
    end;

    select *
      into registration_row
      from public.open_play_host_session_registrations registration
     where registration.id = registration_id
     for share;
    if not found
       or registration_row.receipt_verification_id is distinct from
            p_receipt_verification_id
       or registration_row.payment_status <> 'paid'
       or registration_row.receipt_status <> 'auto_approved'
       or cardinality(coalesce(
            registration_row.receipt_flags,
            array[]::text[]
          )) <> 0
       or registration_row.session_id is distinct from p_session_id
       or lower(regexp_replace(
            trim(coalesce(registration_row.full_name, '')),
            '[[:space:]]+',
            ' ',
            'g'
          )) <> lower(regexp_replace(
            trim(coalesce(p_full_name, '')),
            '[[:space:]]+',
            ' ',
            'g'
          ))
       or trim(coalesce(registration_row.contact_number, '')) <>
            trim(coalesce(p_contact_number, ''))
       or lower(trim(coalesce(registration_row.payment_method, ''))) <>
            lower(trim(coalesce(p_payment_method, '')))
       or public.normalize_payment_reference_key(
            registration_row.payment_method,
            registration_row.gcash_ref
          ) is distinct from public.normalize_payment_reference_key(
            p_payment_method,
            p_gcash_ref
          )
       or registration_row.receipt_image_url is distinct from
            trim(p_receipt_image_url) then
      raise exception 'Receipt verification retry does not match its original registration.'
        using errcode = '23505';
    end if;

    return query
    select
      registration_row.id,
      registration_row.session_id,
      registration_row.payment_status,
      registration_row.amount,
      registration_row.receipt_status,
      registration_row.created_at;
    return;
  end if;

  select submitted.id
    into registration_id
    from public.submit_public_host_session_registration(
      p_session_id,
      p_full_name,
      p_contact_number,
      p_payment_method,
      p_gcash_ref,
      p_receipt_image_url,
      'manual_review'
    ) submitted;

  select *
    into registration_row
    from public.open_play_host_session_registrations registration
   where registration.id = registration_id
   for update;

  select session.date
    into session_date
    from public.open_play_host_sessions session
   where session.id = registration_row.session_id;
  if not found then
    raise exception 'Host session was not found.' using errcode = 'P0002';
  end if;

  audit_row := public.assert_clean_registration_receipt(
    p_receipt_verification_id,
    registration_row.payment_method,
    registration_row.gcash_ref,
    'host_session',
    registration_row.amount,
    registration_row.receipt_image_url,
    registration_row.full_name,
    session_date,
    registration_row.session_id::text,
    null
  );

  insert into public.receipt_verification_subject_claims (
    receipt_verification_id,
    subject_scope,
    subject_id
  ) values (
    audit_row.id,
    'host_session',
    registration_row.id::text
  );

  perform public.claim_verified_receipt_evidence_keys(
    audit_row.extracted,
    registration_row.payment_method,
    registration_row.gcash_ref,
    'host_session',
    registration_row.id::text,
    'hs:' || registration_row.id::text
  );

  update public.open_play_host_session_registrations registration
     set payment_status = 'paid',
         receipt_status = 'auto_approved',
         receipt_flags = array[]::text[],
         receipt_extracted = audit_row.extracted,
         receipt_confidence = audit_row.confidence,
         receipt_image_hash = audit_row.image_hash,
         receipt_phash = audit_row.phash,
         receipt_verified_at = audit_row.created_at,
         receipt_verification_id = audit_row.id
   where registration.id = registration_row.id
     and registration.payment_status = 'pending'
     and registration.receipt_status = 'manual_review'
  returning * into registration_row;
  if not found then
    raise exception 'Host-session registration changed before receipt approval.'
      using errcode = '40001';
  end if;

  return query
  select
    registration_row.id,
    registration_row.session_id,
    registration_row.payment_status,
    registration_row.amount,
    registration_row.receipt_status,
    registration_row.created_at;
end;
$$;

revoke all on function public.submit_verified_public_host_session_registration(
  uuid, text, text, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.submit_verified_public_host_session_registration(
  uuid, text, text, text, text, text, bigint
) to service_role;

-- Atomic owner/court-owner Not Received action for a regular booking or its
-- complete logical group. The payment decision audit trigger below commits in
-- the same transaction; any concurrent state change rolls the rejection back.
create or replace function public.reject_booking_payment_transaction(
  p_booking_ref text,
  p_reason text
)
returns table (
  transitioned boolean,
  booking_ref text,
  booking_status text,
  booking_payment_status text,
  booking_refs text[]
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_ref text := nullif(trim(coalesce(p_booking_ref, '')), '');
  rejection_reason text := nullif(
    left(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g'), 1000),
    ''
  );
  observed_group_ref text;
  logical_booking_key text;
  actual_refs text[];
  current_statuses text[];
  current_payment_statuses text[];
  current_methods text[];
  updated_count integer;
begin
  if not public.has_account_role(array['owner', 'court_owner']) then
    raise exception 'Only an active owner or court owner can reject a payment.'
      using errcode = '42501';
  end if;
  if requested_ref is null then
    raise exception 'A booking reference is required.' using errcode = '22023';
  end if;
  if char_length(coalesce(rejection_reason, '')) < 3 then
    raise exception 'A Not Received reason of at least 3 characters is required.'
      using errcode = '22023';
  end if;

  select nullif(trim(coalesce(b.booking_group_ref, '')), '')
    into observed_group_ref
    from public.bookings b
   where b.ref = requested_ref;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  logical_booking_key := coalesce(observed_group_ref, requested_ref);
  perform pg_advisory_xact_lock(
    hashtextextended(
      'paddle-rage-booking-payment-rejection:' || logical_booking_key,
      0
    )
  );
  if observed_group_ref is not null then
    perform pg_advisory_xact_lock(
      hashtextextended(
        'paddle-rage-public-booking-group:' || observed_group_ref,
        0
      )
    );
  end if;

  if observed_group_ref is null then
    perform 1
      from public.bookings b
     where b.ref = requested_ref
     for update;
    actual_refs := array[requested_ref];
  else
    perform 1
      from public.bookings b
     where b.booking_group_ref = observed_group_ref
     order by b.ref
     for update;
    select array_agg(b.ref order by b.ref)
      into actual_refs
      from public.bookings b
     where b.booking_group_ref = observed_group_ref;
  end if;

  if actual_refs is null or not (requested_ref = any(actual_refs)) then
    raise exception 'Booking group changed while rejection was starting.'
      using errcode = '40001';
  end if;

  select
    array_agg(distinct lower(trim(coalesce(b.status, '')))),
    array_agg(distinct lower(trim(coalesce(b.payment_status, '')))),
    array_agg(distinct lower(trim(coalesce(b.payment_method, 'cash'))))
    into current_statuses, current_payment_statuses, current_methods
    from public.bookings b
   where b.ref = any(actual_refs);

  if cardinality(current_statuses) = 1
     and current_statuses[1] = 'cancelled'
     and cardinality(current_payment_statuses) = 1
     and current_payment_statuses[1] = 'rejected' then
    return query
    select false, requested_ref, 'cancelled'::text, 'rejected'::text,
           actual_refs;
    return;
  end if;
  if cardinality(current_statuses) <> 1
     or cardinality(current_payment_statuses) <> 1
     or cardinality(current_methods) <> 1 then
    raise exception 'Grouped booking payment states are mixed.'
      using errcode = '22023';
  end if;
  if current_statuses[1] not in ('verifying', 'pending')
     or current_payment_statuses[1] not in
       ('unpaid', 'pending', 'for_verification') then
    raise exception 'This payment is no longer awaiting review.'
      using errcode = '22023';
  end if;
  if current_methods[1] not in (
    'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'pnb'
  ) then
    raise exception 'Only a digital payment review can use Not Received.'
      using errcode = '22023';
  end if;

  perform set_config(
    'paddle_rage.manual_payment_rejection_reason',
    rejection_reason,
    true
  );

  update public.bookings b
     set status = 'cancelled',
         payment_status = 'rejected',
         receipt_status = 'rejected',
         paid_at = null
   where b.ref = any(actual_refs)
     and b.status = current_statuses[1]
     and b.payment_status = current_payment_statuses[1];

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(actual_refs) then
    raise exception 'Booking state changed before the complete group could be rejected.'
      using errcode = '40001';
  end if;

  return query
  select true, requested_ref, 'cancelled'::text, 'rejected'::text,
         actual_refs;
end;
$$;

revoke all on function public.reject_booking_payment_transaction(text, text)
  from public, anon, authenticated;
grant execute on function public.reject_booking_payment_transaction(text, text)
  to authenticated;

create or replace function public.audit_manual_registration_payment_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role_value text := public.current_account_role();
  decision_value text;
  audit_booking_ref text;
  audit_group_ref text;
  audit_receipt_id bigint;
  decision_reason text;
begin
  if actor_role_value not in ('owner', 'court_owner') or auth.uid() is null then
    return new;
  end if;

  if tg_table_name = 'bookings' then
    if old.payment_status in ('unpaid', 'pending', 'for_verification')
       and new.payment_status in ('paid', 'downpayment_paid')
       and new.status = 'confirmed' then
      decision_value := 'approve';
      decision_reason := 'Receipt manually reviewed and payment confirmed.';
    elsif old.payment_status in ('unpaid', 'pending', 'for_verification')
       and new.payment_status = 'rejected'
       and new.status = 'cancelled' then
      decision_value := 'reject';
      decision_reason := coalesce(
        nullif(current_setting(
          'paddle_rage.manual_payment_rejection_reason',
          true
        ), ''),
        'Payment marked Not Received by an owner.'
      );
    else
      return new;
    end if;
    audit_booking_ref := new.ref;
    audit_group_ref := nullif(trim(coalesce(new.booking_group_ref, '')), '');
  elsif tg_table_name = 'open_play_registrations' then
    if old.payment_status = 'pending' and new.payment_status = 'paid' then
      decision_value := 'approve';
    elsif old.payment_status = 'pending' and new.payment_status = 'rejected' then
      decision_value := 'reject';
    else
      return new;
    end if;
    decision_reason := case decision_value
      when 'approve' then 'Open Play receipt manually confirmed.'
      else 'Open Play payment marked Not Received by an owner.'
    end;
    audit_booking_ref := 'op:' || new.id::text;
    audit_group_ref := null;
    audit_receipt_id := new.receipt_verification_id;
  elsif tg_table_name = 'open_play_host_session_registrations' then
    if old.payment_status = 'pending' and new.payment_status = 'paid' then
      decision_value := 'approve';
    elsif old.payment_status = 'pending' and new.payment_status = 'rejected' then
      decision_value := 'reject';
    else
      return new;
    end if;
    decision_reason := case decision_value
      when 'approve' then 'Host-session receipt manually confirmed.'
      else 'Host-session payment marked Not Received by an owner.'
    end;
    audit_booking_ref := 'hs:' || new.id::text;
    audit_group_ref := new.session_id::text;
    audit_receipt_id := new.receipt_verification_id;
  else
    return new;
  end if;

  if audit_receipt_id is null and new.receipt_image_hash is not null then
    select verification.id
      into audit_receipt_id
      from public.receipt_verifications verification
     where verification.image_hash = new.receipt_image_hash
     order by verification.created_at desc, verification.id desc
     limit 1;
  end if;

  insert into public.payment_review_decisions (
    receipt_verification_id,
    booking_ref,
    booking_group_ref,
    decision,
    actor_user_id,
    actor_role,
    reason,
    prior_receipt_status,
    prior_receipt_flags
  ) values (
    audit_receipt_id,
    audit_booking_ref,
    audit_group_ref,
    decision_value,
    auth.uid(),
    actor_role_value,
    decision_reason,
    old.receipt_status,
    coalesce(old.receipt_flags, array[]::text[])
  );

  return new;
end;
$$;

drop trigger if exists z95_audit_manual_booking_payment_decision
  on public.bookings;
create trigger z95_audit_manual_booking_payment_decision
after update of status, payment_status on public.bookings
for each row execute function public.audit_manual_registration_payment_decision();

drop trigger if exists z95_audit_manual_open_play_payment_decision
  on public.open_play_registrations;
create trigger z95_audit_manual_open_play_payment_decision
after update of payment_status on public.open_play_registrations
for each row execute function public.audit_manual_registration_payment_decision();

drop trigger if exists z95_audit_manual_host_session_payment_decision
  on public.open_play_host_session_registrations;
create trigger z95_audit_manual_host_session_payment_decision
after update of payment_status on public.open_play_host_session_registrations
for each row execute function public.audit_manual_registration_payment_decision();

create or replace function public.audit_manual_host_balance_payment_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status in ('approved', 'rejected')
     or new.status not in ('approved', 'rejected')
     or new.reviewed_by_role not in ('owner', 'court_owner')
     or new.reviewed_by_user_id is null then
    return new;
  end if;

  insert into public.payment_review_decisions (
    receipt_verification_id,
    booking_ref,
    booking_group_ref,
    decision,
    actor_user_id,
    actor_role,
    reason,
    prior_receipt_status,
    prior_receipt_flags
  ) values (
    new.receipt_verification_id,
    new.booking_ref,
    new.booking_group_ref,
    case when new.status = 'approved' then 'approve' else 'reject' end,
    new.reviewed_by_user_id,
    new.reviewed_by_role,
    new.review_reason,
    old.receipt_result,
    coalesce(old.receipt_flags, array[]::text[])
  );

  return new;
end;
$$;

drop trigger if exists z95_audit_manual_host_balance_payment_decision
  on public.host_booking_balance_payments;
create trigger z95_audit_manual_host_balance_payment_decision
after update of status on public.host_booking_balance_payments
for each row execute function public.audit_manual_host_balance_payment_decision();

comment on function public.reject_booking_payment_transaction(text, text) is
  'Atomically records an owner/court-owner Not Received decision for a complete booking group and releases its slots.';
comment on function public.prevent_automatic_receipt_rejection() is
  'Converts parser/verifier rejection or unsafe claimed auto-approval to pending manual review without changing clean auto-approval.';
comment on function public.prevent_automatic_booking_rejection() is
  'Prevents automated/public receipt rejection while preserving deliberate owner Not Received.';

notify pgrst, 'reload schema';

commit;

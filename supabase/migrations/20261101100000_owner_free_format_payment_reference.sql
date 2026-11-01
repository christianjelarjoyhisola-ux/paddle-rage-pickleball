-- Let the system owner and court owner save a payment reference exactly as it
-- is printed on the receipt, even when it does not match the provider format
-- the checkout enforces (for example a BDO Pay booking whose receipt shows a
-- non-"BN" reference).
--
-- What stays strict:
--   * players and the automatic receipt verifier still get the full
--     provider-specific format checks;
--   * a reference already used by any other booking, registration or paid
--     payment is still refused, and confirmation still claims it;
--   * a receipt whose scan shows the very reference being replaced is still a
--     real duplicate and cannot be corrected.
--
-- What changes:
--   * normalize_payment_reference_key accepts any 4-40 character
--     letters/digits reference when the caller is an active owner/court owner,
--     so the same booking can then be confirmed;
--   * when the corrected reference does not match the receipt scan, both the
--     system owner and the court owner may save it after ticking
--     "I checked the receipt image". That acknowledgement is audited.

begin;

-- 1. Keep the existing strict checker under a new name (exact live definition,
--    including the UnionBank and RCBC additions from earlier migrations).
do $strict_copy$
declare
  definition text;
begin
  if to_regprocedure('public.normalize_payment_reference_key_strict(text,text)') is not null then
    return;
  end if;
  definition := pg_get_functiondef('public.normalize_payment_reference_key(text,text)'::regprocedure);
  definition := replace(
    definition,
    'FUNCTION public.normalize_payment_reference_key(',
    'FUNCTION public.normalize_payment_reference_key_strict('
  );
  if position('normalize_payment_reference_key_strict(' in definition) = 0 then
    raise exception 'Could not copy the strict payment reference checker.';
  end if;
  execute definition;
end;
$strict_copy$;

revoke all on function public.normalize_payment_reference_key_strict(text, text)
  from public, anon, authenticated;

-- 2. Public name: strict for everyone, lenient on format only for owners.
create or replace function public.normalize_payment_reference_key(
  p_provider text,
  p_typed_reference text
)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  provider_value text := lower(trim(coalesce(p_provider, '')));
  cleaned text;
begin
  return public.normalize_payment_reference_key_strict(p_provider, p_typed_reference);
exception when sqlstate '22023' then
  if auth.uid() is null
     or coalesce(public.current_account_role(), '') not in ('owner', 'court_owner')
     or provider_value not in (
       'gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'maribank', 'unionbank', 'pnb', 'rcbc'
     ) then
    raise;
  end if;
  cleaned := case
    when provider_value = 'gcash' then regexp_replace(coalesce(p_typed_reference, ''), '[^0-9]', '', 'g')
    else upper(regexp_replace(coalesce(p_typed_reference, ''), '[^A-Za-z0-9]', '', 'g'))
  end;
  if cleaned !~ '^[A-Z0-9]{4,40}$' then
    raise;
  end if;
  return case
    when provider_value = 'gcash' then cleaned
    else provider_value || ':' || cleaned
  end;
end;
$$;

revoke all on function public.normalize_payment_reference_key(text, text)
  from public, anon, authenticated;

-- 3. Court owners may also acknowledge a scan mismatch (audited).
alter table public.booking_payment_reference_corrections
  drop constraint if exists booking_payment_reference_corrections_override_check;

do $relax_correction$
declare
  definition text;
  patched text;
begin
  definition := pg_get_functiondef(
    'public.correct_booking_payment_reference(text,text,text,boolean,uuid)'::regprocedure
  );
  if position('Only the system owner can correct a reference' in definition) = 0
     and position('I checked the receipt image' in definition) > 0 then
    return; -- already relaxed
  end if;
  patched := replace(
    definition,
    $old$    if v_actor_role <> 'owner' then
      raise exception 'Only the system owner can correct a reference that the receipt scan did not confirm.'
        using errcode = '42501';
    end if;
$old$,
    ''
  );
  patched := replace(
    patched,
    'Reread the receipt, or ask the system owner to correct it with a scan override.',
    'Check the receipt image, then tick "I checked the receipt image" to save it.'
  );
  patched := replace(
    patched,
    'which does not match the corrected reference. Check the receipt image again.',
    'which does not match. If the receipt image shows your reference, tick "I checked the receipt image" to save it.'
  );
  if patched = definition or position('Only the system owner can correct a reference' in patched) > 0 then
    raise exception 'Could not relax the reference correction function.';
  end if;
  execute patched;
end;
$relax_correction$;

commit;

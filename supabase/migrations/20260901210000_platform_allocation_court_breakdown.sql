-- ============================================================================
-- Platform allocation: authoritative accumulating balance by court
--
-- This is an additive dashboard response change. Existing aggregate fields keep
-- their original meaning; court_breakdown is derived from the very same
-- materialized unclaimed booking rows used for those aggregate fields.
-- ============================================================================

begin;

create or replace function public.get_booking_fee_remittance_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  account_role text;
  server_now timestamptz := clock_timestamp();
  local_date date;
  next_due date;
  accumulated_count integer := 0;
  accumulated_reservation_count integer := 0;
  accumulated_billable_hours numeric := 0;
  accumulated_flat_fee_booking_count integer := 0;
  accumulated_rate_type_breakdown jsonb := '[]'::jsonb;
  accumulated_court_breakdown jsonb := '[]'::jsonb;
  accumulated_court_breakdown_meta jsonb := '{}'::jsonb;
  gross_booking_amount numeric := 0;
  adjustment_count integer := 0;
  adjustment_amount numeric := 0;
  attributed_adjustment_count integer := 0;
  attributed_adjustment_amount numeric := 0;
  unattributed_adjustment_count integer := 0;
  unattributed_adjustment_amount numeric := 0;
  unknown_court_adjustment_count integer := 0;
  net_accumulated numeric := 0;
  accumulated_start timestamptz;
  adjustment_start timestamptz;
  court_booking_rows_total integer := 0;
  court_billable_hours_total numeric := 0;
  court_flat_fee_booking_count_total integer := 0;
  court_gross_booking_amount_total numeric := 0;
  court_adjustment_amount_total numeric := 0;
  court_net_contribution_total numeric := 0;
  open_rows jsonb := '[]'::jsonb;
  open_remaining numeric := 0;
  settled_total numeric := 0;
  last_settled jsonb;
begin
  account_role := public.current_account_role();
  if account_role is null or account_role not in ('owner', 'court_owner') then
    raise exception 'Only active system owners and court owners can view remittances.'
      using errcode = '42501';
  end if;

  local_date := timezone('Asia/Manila', server_now)::date;
  next_due := public.booking_fee_next_due_on(server_now);

  with unclaimed as materialized (
    select
      u.*,
      case
        when nullif(btrim(u.booking_group_ref), '') is not null
          then 'group:' || btrim(u.booking_group_ref)
        else 'booking:' || u.booking_ref
      end as reservation_key,
      case
        when nullif(btrim(coalesce(u.court_id, '')), '') is not null
          then 'court-id:' || btrim(u.court_id)
        when nullif(btrim(coalesce(u.court_name, '')), '') is not null
          then 'court-name:' || lower(
            regexp_replace(btrim(u.court_name), '\s+', ' ', 'g')
          )
        else 'court-unknown'
      end as court_key,
      case
        when nullif(btrim(coalesce(u.court_id, '')), '') is not null then 'court_id'
        when nullif(btrim(coalesce(u.court_name, '')), '') is not null then 'court_name_fallback'
        else 'unknown'
      end as court_key_source
    from public.booking_fee_unclaimed_rows() u
  ),
  rate_rows as (
    select
      u.fee_type,
      u.fee_rate,
      count(*)::integer as item_count,
      count(distinct u.reservation_key)::integer as reservation_count,
      round(sum(u.fee_units), 2) as fee_units,
      coalesce(
        round(sum(u.fee_units) filter (where u.fee_type = 'per_hour'), 2),
        0::numeric
      ) as billable_hours,
      (count(*) filter (where u.fee_type = 'flat'))::integer
        as flat_fee_booking_count,
      round(sum(u.fee_amount), 2) as amount,
      case u.fee_type when 'per_hour' then 1 else 2 end as sort_order
    from unclaimed u
    group by u.fee_type, u.fee_rate
  ),
  court_rate_rows as (
    select
      u.court_key,
      u.fee_type,
      u.fee_rate,
      count(*)::integer as item_count,
      count(distinct u.reservation_key)::integer as reservation_count,
      round(sum(u.fee_units), 2) as fee_units,
      coalesce(
        round(sum(u.fee_units) filter (where u.fee_type = 'per_hour'), 2),
        0::numeric
      ) as billable_hours,
      (count(*) filter (where u.fee_type = 'flat'))::integer
        as flat_fee_booking_count,
      round(sum(u.fee_amount), 2) as amount,
      case u.fee_type when 'per_hour' then 1 else 2 end as sort_order
    from unclaimed u
    group by u.court_key, u.fee_type, u.fee_rate
  ),
  court_rate_breakdowns as (
    select
      x.court_key,
      jsonb_agg(
        jsonb_build_object(
          'fee_type', x.fee_type,
          'fee_rate', x.fee_rate,
          'booking_count', x.item_count,
          'item_count', x.item_count,
          'booking_rows_count', x.item_count,
          'reservation_count', x.reservation_count,
          'fee_units', x.fee_units,
          'unit_count', x.fee_units,
          'billable_hours', x.billable_hours,
          'court_hours', x.billable_hours,
          'flat_fee_booking_count', x.flat_fee_booking_count,
          'amount', x.amount
        )
        order by x.sort_order, x.fee_rate
      ) as rows
    from court_rate_rows x
    group by x.court_key
  ),
  court_labels as (
    select distinct on (u.court_key)
      u.court_key,
      u.court_key_source,
      nullif(btrim(coalesce(u.court_id, '')), '') as court_id,
      nullif(btrim(coalesce(u.court_name, '')), '') as court_name
    from unclaimed u
    order by
      u.court_key,
      (nullif(btrim(coalesce(u.court_name, '')), '') is not null) desc,
      u.fee_earned_at desc nulls last,
      u.booking_ref desc
  ),
  court_booking_totals as (
    select
      u.court_key,
      u.court_key_source,
      count(*)::integer as booking_rows_count,
      count(distinct u.reservation_key)::integer as reservation_count,
      coalesce(
        round(sum(u.fee_units) filter (where u.fee_type = 'per_hour'), 2),
        0::numeric
      ) as billable_hours,
      (count(*) filter (where u.fee_type = 'flat'))::integer
        as flat_fee_booking_count,
      coalesce(round(sum(u.fee_amount), 2), 0::numeric)
        as gross_booking_fee_amount
    from unclaimed u
    group by u.court_key, u.court_key_source
  )
  select
    count(*)::integer,
    count(distinct u.reservation_key)::integer,
    coalesce(
      round(sum(u.fee_units) filter (where u.fee_type = 'per_hour'), 2),
      0::numeric
    ),
    (count(*) filter (where u.fee_type = 'flat'))::integer,
    coalesce(round(sum(u.fee_amount), 2), 0::numeric),
    min(u.fee_earned_at),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'fee_type', x.fee_type,
          'fee_rate', x.fee_rate,
          'booking_count', x.item_count,
          'item_count', x.item_count,
          'booking_rows_count', x.item_count,
          'reservation_count', x.reservation_count,
          'fee_units', x.fee_units,
          'unit_count', x.fee_units,
          'billable_hours', x.billable_hours,
          'court_hours', x.billable_hours,
          'flat_fee_booking_count', x.flat_fee_booking_count,
          'amount', x.amount
        )
        order by x.sort_order, x.fee_rate
      )
      from rate_rows x
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'court_key', c.court_key,
          'court_key_source', c.court_key_source,
          'court_id', l.court_id,
          'court_name', l.court_name,
          'booking_rows_count', c.booking_rows_count,
          'reservation_count', c.reservation_count,
          'billable_hours', c.billable_hours,
          'court_hours', c.billable_hours,
          'flat_fee_booking_count', c.flat_fee_booking_count,
          'gross_booking_fee_amount', c.gross_booking_fee_amount,
          'fee_breakdown', coalesce(rb.rows, '[]'::jsonb),
          'rate_type_breakdown', coalesce(rb.rows, '[]'::jsonb)
        )
        order by lower(coalesce(l.court_name, l.court_id, c.court_key)), c.court_key
      )
      from court_booking_totals c
      join court_labels l on l.court_key = c.court_key
      left join court_rate_breakdowns rb on rb.court_key = c.court_key
    ), '[]'::jsonb)
    into
      accumulated_count,
      accumulated_reservation_count,
      accumulated_billable_hours,
      accumulated_flat_fee_booking_count,
      gross_booking_amount,
      accumulated_start,
      accumulated_rate_type_breakdown,
      accumulated_court_breakdown
    from unclaimed u;

  -- Every adjustment names its immutable source remittance and booking line.
  -- Attribute it only when that pair resolves to exactly one frozen item. Any
  -- missing or ambiguous source remains authoritative at the top level and is
  -- reported as unattributed in metadata instead of being guessed into a court.
  with current_adjustments as materialized (
    select * from public.booking_fee_unclaimed_adjustments()
  ),
  source_matches as (
    select
      a.adjustment_id,
      a.adjustment_ref,
      a.booking_ref,
      a.booking_group_ref,
      a.source_remittance_id,
      a.adjustment_type,
      a.amount,
      a.reason,
      a.effective_at,
      count(i.id)::integer as source_match_count,
      max(nullif(btrim(coalesce(i.court_id, '')), '')) as court_id,
      max(nullif(btrim(coalesce(i.court_name, '')), '')) as court_name
    from current_adjustments a
    left join public.booking_fee_remittance_items i
      on i.remittance_id = a.source_remittance_id
     and i.booking_ref = a.booking_ref
    group by
      a.adjustment_id,
      a.adjustment_ref,
      a.booking_ref,
      a.booking_group_ref,
      a.source_remittance_id,
      a.adjustment_type,
      a.amount,
      a.reason,
      a.effective_at
  ),
  attributed_adjustments as (
    select
      s.*,
      case
        when s.court_id is not null
          then 'court-id:' || s.court_id
        when s.court_name is not null
          then 'court-name:' || lower(
            regexp_replace(s.court_name, '\s+', ' ', 'g')
          )
        else 'court-unknown'
      end as court_key,
      case
        when s.court_id is not null then 'court_id'
        when s.court_name is not null then 'court_name_fallback'
        else 'unknown'
      end as court_key_source
    from source_matches s
    where s.source_match_count = 1
      and (s.court_id is not null or s.court_name is not null)
  ),
  unattributed_adjustments as (
    select s.*
    from source_matches s
    where s.source_match_count <> 1
       or (s.court_id is null and s.court_name is null)
  ),
  adjustment_court_totals as (
    select
      a.court_key,
      a.court_key_source,
      count(*)::integer as adjustment_count,
      coalesce(round(sum(a.amount), 2), 0::numeric) as adjustment_amount
    from attributed_adjustments a
    group by a.court_key, a.court_key_source
  ),
  adjustment_court_labels as (
    select distinct on (a.court_key)
      a.court_key,
      nullif(btrim(coalesce(a.court_id, '')), '') as court_id,
      nullif(btrim(coalesce(a.court_name, '')), '') as court_name
    from attributed_adjustments a
    order by
      a.court_key,
      (nullif(btrim(coalesce(a.court_name, '')), '') is not null) desc,
      a.effective_at desc,
      a.adjustment_id desc
  ),
  booking_courts as (
    select *
    from jsonb_to_recordset(accumulated_court_breakdown) as b(
      court_key text,
      court_key_source text,
      court_id text,
      court_name text,
      booking_rows_count integer,
      reservation_count integer,
      billable_hours numeric,
      court_hours numeric,
      flat_fee_booking_count integer,
      gross_booking_fee_amount numeric,
      fee_breakdown jsonb,
      rate_type_breakdown jsonb
    )
  ),
  final_courts as (
    select
      coalesce(b.court_key, a.court_key) as court_key,
      coalesce(b.court_key_source, a.court_key_source) as court_key_source,
      coalesce(b.court_id, al.court_id) as court_id,
      coalesce(b.court_name, al.court_name) as court_name,
      coalesce(b.booking_rows_count, 0)::integer as booking_rows_count,
      coalesce(b.reservation_count, 0)::integer as reservation_count,
      coalesce(b.billable_hours, 0::numeric) as billable_hours,
      coalesce(b.court_hours, 0::numeric) as court_hours,
      coalesce(b.flat_fee_booking_count, 0)::integer as flat_fee_booking_count,
      coalesce(b.gross_booking_fee_amount, 0::numeric) as gross_booking_fee_amount,
      coalesce(a.adjustment_count, 0)::integer as adjustment_count,
      coalesce(a.adjustment_amount, 0::numeric) as adjustment_amount,
      round(
        coalesce(b.gross_booking_fee_amount, 0::numeric)
        + coalesce(a.adjustment_amount, 0::numeric),
        2
      ) as net_contribution,
      coalesce(b.fee_breakdown, '[]'::jsonb) as fee_breakdown,
      coalesce(b.rate_type_breakdown, '[]'::jsonb) as rate_type_breakdown
    from booking_courts b
    full join adjustment_court_totals a on a.court_key = b.court_key
    left join adjustment_court_labels al
      on al.court_key = coalesce(b.court_key, a.court_key)
  )
  select
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'court_key', c.court_key,
          'court_key_source', c.court_key_source,
          'court_id', c.court_id,
          'court_name', c.court_name,
          'booking_rows_count', c.booking_rows_count,
          'reservation_count', c.reservation_count,
          'billable_hours', c.billable_hours,
          'court_hours', c.court_hours,
          'flat_fee_booking_count', c.flat_fee_booking_count,
          'gross_booking_fee_amount', c.gross_booking_fee_amount,
          'adjustment_count', c.adjustment_count,
          'adjustment_amount', c.adjustment_amount,
          'net_contribution', c.net_contribution,
          'fee_breakdown', c.fee_breakdown,
          'rate_type_breakdown', c.rate_type_breakdown
        )
        order by lower(coalesce(c.court_name, c.court_id, c.court_key)), c.court_key
      )
      from final_courts c
    ), '[]'::jsonb),
    (select count(*)::integer from current_adjustments),
    coalesce((select round(sum(a.amount), 2) from current_adjustments a), 0::numeric),
    (select min(a.effective_at) from current_adjustments a),
    (select count(*)::integer from attributed_adjustments),
    coalesce((
      select round(sum(a.amount), 2)
      from attributed_adjustments a
    ), 0::numeric),
    (select count(*)::integer from unattributed_adjustments),
    coalesce((
      select round(sum(a.amount), 2)
      from unattributed_adjustments a
    ), 0::numeric),
    (select count(*)::integer
       from source_matches s
      where s.source_match_count = 1
        and s.court_id is null
        and s.court_name is null)
    into
      accumulated_court_breakdown,
      adjustment_count,
      adjustment_amount,
      adjustment_start,
      attributed_adjustment_count,
      attributed_adjustment_amount,
      unattributed_adjustment_count,
      unattributed_adjustment_amount,
      unknown_court_adjustment_count;

  net_accumulated := round(gross_booking_amount + adjustment_amount, 2);
  accumulated_start := case
    when accumulated_start is null then adjustment_start
    when adjustment_start is null then accumulated_start
    else least(accumulated_start, adjustment_start)
  end;

  select
    coalesce(sum(c.booking_rows_count), 0)::integer,
    coalesce(round(sum(c.billable_hours), 2), 0::numeric),
    coalesce(sum(c.flat_fee_booking_count), 0)::integer,
    coalesce(round(sum(c.gross_booking_fee_amount), 2), 0::numeric),
    coalesce(round(sum(c.adjustment_amount), 2), 0::numeric),
    coalesce(round(sum(c.net_contribution), 2), 0::numeric)
    into
      court_booking_rows_total,
      court_billable_hours_total,
      court_flat_fee_booking_count_total,
      court_gross_booking_amount_total,
      court_adjustment_amount_total,
      court_net_contribution_total
    from jsonb_to_recordset(accumulated_court_breakdown) as c(
      booking_rows_count integer,
      billable_hours numeric,
      flat_fee_booking_count integer,
      gross_booking_fee_amount numeric,
      adjustment_amount numeric,
      net_contribution numeric
    );

  accumulated_court_breakdown_meta := jsonb_build_object(
    'version', 1,
    'basis', 'same_materialized_unclaimed_booking_rows_plus_exact_source_adjustments',
    'court_grouping', 'court_id_then_normalized_court_name_then_unknown',
    'reservation_count_scope', 'distinct_within_each_court',
    'reservation_count_additive', false,
    'adjustment_attribution', jsonb_build_object(
      'basis', 'exact_immutable_source_remittance_item',
      'coverage', case
        when adjustment_count = 0 then 'not_applicable'
        when unattributed_adjustment_count = 0 then 'complete'
        else 'partial'
      end,
      'exactly_attributed_rows_included', true,
      'top_level_count', adjustment_count,
      'top_level_amount', adjustment_amount,
      'attributed_count', attributed_adjustment_count,
      'attributed_amount', attributed_adjustment_amount,
      'unattributed_count', unattributed_adjustment_count,
      'unattributed_amount', unattributed_adjustment_amount,
      'unknown_court_count', unknown_court_adjustment_count
    ),
    'court_totals', jsonb_build_object(
      'booking_rows_count', court_booking_rows_total,
      'billable_hours', court_billable_hours_total,
      'court_hours', court_billable_hours_total,
      'flat_fee_booking_count', court_flat_fee_booking_count_total,
      'gross_booking_fee_amount', court_gross_booking_amount_total,
      'attributed_adjustment_amount', court_adjustment_amount_total,
      'net_contribution', court_net_contribution_total
    ),
    'reconciliation', jsonb_build_object(
      'booking_rows_match', court_booking_rows_total = accumulated_count,
      'billable_hours_match', court_billable_hours_total = accumulated_billable_hours,
      'flat_fee_booking_count_match',
        court_flat_fee_booking_count_total = accumulated_flat_fee_booking_count,
      'gross_booking_fee_amount_match',
        court_gross_booking_amount_total = gross_booking_amount,
      'adjustment_amount_match',
        unattributed_adjustment_count = 0
        and court_adjustment_amount_total = adjustment_amount,
      'net_amount_match',
        unattributed_adjustment_count = 0
        and court_net_contribution_total = net_accumulated
    )
  );

  select
    coalesce(
      jsonb_agg(
        public.booking_fee_remittance_summary_json(r.id)
        order by r.cycle_due_on, r.prepared_at
      ),
      '[]'::jsonb
    ),
    coalesce(sum(greatest(r.amount_due - r.amount_settled, 0)), 0)
    into open_rows, open_remaining
    from public.booking_fee_remittances r
   where r.status not in ('settled', 'cancelled');

  select public.booking_fee_remittance_summary_json(r.id)
    into last_settled
    from public.booking_fee_remittances r
   where r.status = 'settled'
   order by r.settled_at desc nulls last, r.prepared_at desc
   limit 1;

  select coalesce(round(sum(r.amount_settled), 2), 0)
    into settled_total
    from public.booking_fee_remittances r
   where r.status <> 'cancelled';

  return jsonb_build_object(
    'server_now', server_now,
    'timezone', 'Asia/Manila',
    'role', account_role,
    'next_due_on', next_due,
    'can_prepare', local_date >= next_due and net_accumulated > 0,
    'can_owner_override', account_role = 'owner',
    'accumulated', jsonb_build_object(
      'bookings_count', accumulated_count,
      'booking_rows_count', accumulated_count,
      'reservation_count', accumulated_reservation_count,
      'billable_hours', accumulated_billable_hours,
      'court_hours', accumulated_billable_hours,
      'flat_fee_booking_count', accumulated_flat_fee_booking_count,
      'fee_breakdown', accumulated_rate_type_breakdown,
      'rate_type_breakdown', accumulated_rate_type_breakdown,
      'court_breakdown', accumulated_court_breakdown,
      'court_breakdown_meta', accumulated_court_breakdown_meta,
      'gross_booking_fee_amount', gross_booking_amount,
      'adjustment_count', adjustment_count,
      'adjustment_amount', adjustment_amount,
      'net_amount', net_accumulated,
      'credit_carryforward', greatest(-net_accumulated, 0),
      'amount', greatest(net_accumulated, 0),
      'coverage_start_at', accumulated_start
    ),
    'open_remaining_balance', round(open_remaining, 2),
    'total_outstanding_balance', round(open_remaining + greatest(net_accumulated, 0), 2),
    'accepted_total', settled_total,
    'settled_total', settled_total,
    'open_remittances', open_rows,
    'last_settled', last_settled
  );
end;
$$;

revoke all on function public.get_booking_fee_remittance_dashboard()
  from public, anon, authenticated;
grant execute on function public.get_booking_fee_remittance_dashboard()
  to authenticated;

comment on function public.get_booking_fee_remittance_dashboard() is
  'Returns authoritative platform-allocation balances plus an additive live per-court breakdown from the same unclaimed ledger snapshot; adjustment attribution is exact-only and reports coverage.';

notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- Month-end remittance statements
--
-- The platform allocation now closes automatically at the end of every
-- Asia/Manila calendar month. Court owners no longer prepare a cutoff and
-- statements carry no payment due date: each closed month becomes one
-- statement that the court owner pays and submits proof for.
--
--   * booking_fee_close_month() freezes every unclaimed fee and adjustment
--     earned through the last instant of the previous Manila month. The
--     cutoff comes from the month boundary, not from when the job runs, so a
--     late or repeated run produces exactly the same statement.
--   * cycle_due_on now holds the statement month's last day (the period key),
--     so is_overdue is always false.
--   * prepare_booking_fee_remittance is retired; pg_cron runs the close daily
--     at 00:05 Asia/Manila so a missed run is caught up the next day.
-- ============================================================================

begin;

-- --------------------------------------------------------------------------
-- 1. Next cutoff date: the last day of the current Manila month
-- --------------------------------------------------------------------------

create or replace function public.booking_fee_next_due_on(p_at timestamptz default now())
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (
    date_trunc('month', timezone('Asia/Manila', coalesce(p_at, now())))
    + interval '1 month' - interval '1 day'
  )::date;
$$;

comment on function public.booking_fee_next_due_on(timestamptz) is
  'Returns the next automatic month-end statement cutoff date (last day of the current Asia/Manila month).';

-- --------------------------------------------------------------------------
-- 2. Automatic month-end close
-- --------------------------------------------------------------------------

create or replace function public.booking_fee_close_month(
  p_at timestamptz default now(),
  p_cutoff timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  month_start timestamp;
  cutoff_time timestamptz;
  period_end date;
  existing_id uuid;
  new_id uuid := gen_random_uuid();
  prepared_time timestamptz;
  item_count integer := 0;
  adjustment_count integer := 0;
  gross_booking_amount numeric := 0;
  adjustment_amount numeric := 0;
  total_due numeric := 0;
  coverage_start timestamptz;
  adjustment_start timestamptz;
begin
  -- Close the most recent fully finished Manila month. The cutoff is the last
  -- microsecond of that month so the inclusive <= comparisons below never
  -- claim a fee earned at 00:00 on the 1st.
  month_start := date_trunc('month', timezone('Asia/Manila', coalesce(p_at, now())));
  cutoff_time := (month_start at time zone 'Asia/Manila') - interval '1 microsecond';
  period_end := (month_start - interval '1 day')::date;

  -- One-time catch-up: close the previous month at an exact later instant
  -- instead of the boundary. The next month-end close sweeps the rest.
  if p_cutoff is not null then
    if p_cutoff < cutoff_time or p_cutoff > clock_timestamp() then
      raise exception 'A cutoff override must fall between the month end and now.'
        using errcode = '22023';
    end if;
    cutoff_time := p_cutoff;
  end if;

  -- Fee earning and adjustment creation take the matching shared lock.
  perform pg_advisory_xact_lock(
    hashtextextended('paddle-rage-pickleball-booking-fee-remittance', 0)
  );

  select r.id into existing_id
    from public.booking_fee_remittances r
   where r.scope_key = 'venue'
     and r.cycle_due_on = period_end
     and r.status <> 'cancelled'
   limit 1;
  if existing_id is not null then
    return existing_id;
  end if;

  select
    coalesce((
      select round(sum(u.fee_amount), 2)
        from public.booking_fee_unclaimed_rows() u
       where u.fee_earned_at <= cutoff_time
    ), 0),
    coalesce((
      select round(sum(a.amount), 2)
        from public.booking_fee_unclaimed_adjustments() a
       where a.effective_at <= cutoff_time
    ), 0)
    into gross_booking_amount, adjustment_amount;

  -- Nothing payable this month: credit and fees carry into the next close.
  if round(gross_booking_amount + adjustment_amount, 2) <= 0 then
    return null;
  end if;

  prepared_time := clock_timestamp();

  insert into public.booking_fee_remittances (
    id,
    remittance_ref,
    cycle_due_on,
    cutoff_at,
    status,
    prepared_at,
    prepared_by_user_id,
    prepared_by_email,
    prepared_by_role,
    prepare_idempotency_key,
    owner_override,
    owner_override_reason
  ) values (
    new_id,
    'REM-' || to_char(period_end, 'YYYYMM') || '-' ||
      upper(substr(replace(new_id::text, '-', ''), 1, 8)),
    period_end,
    cutoff_time,
    'prepared',
    prepared_time,
    null,
    null,
    'system',
    'month-end-' || to_char(period_end, 'YYYY-MM') || '-' ||
      substr(replace(new_id::text, '-', ''), 1, 8),
    false,
    null
  );

  insert into public.booking_fee_remittance_items (
    remittance_id,
    booking_ref,
    booking_group_ref,
    booking_created_at,
    fee_earned_at,
    court_id,
    court_name,
    booking_date,
    host_booking,
    created_via,
    fee_amount,
    fee_rate,
    fee_type,
    fee_units,
    fee_snapshot_source
  )
  select
    new_id,
    u.booking_ref,
    u.booking_group_ref,
    u.booking_created_at,
    u.fee_earned_at,
    u.court_id,
    u.court_name,
    u.booking_date,
    u.host_booking,
    u.created_via,
    round(u.fee_amount, 2),
    round(u.fee_rate, 2),
    u.fee_type,
    u.fee_units,
    u.fee_snapshot_source
  from public.booking_fee_unclaimed_rows() u
  where u.fee_earned_at <= cutoff_time
  order by u.fee_earned_at, u.booking_created_at, u.booking_ref
  on conflict (booking_ref) where released_at is null do nothing;

  insert into public.booking_fee_adjustment_applications (
    remittance_id,
    adjustment_id,
    adjustment_ref,
    booking_ref,
    booking_group_ref,
    source_remittance_id,
    adjustment_type,
    amount,
    reason,
    effective_at
  )
  select
    new_id,
    a.adjustment_id,
    a.adjustment_ref,
    a.booking_ref,
    a.booking_group_ref,
    a.source_remittance_id,
    a.adjustment_type,
    round(a.amount, 2),
    a.reason,
    a.effective_at
  from public.booking_fee_unclaimed_adjustments() a
  where a.effective_at <= cutoff_time
  order by a.effective_at, a.adjustment_id
  on conflict (adjustment_id) where released_at is null do nothing;

  select
    count(*)::integer,
    coalesce(round(sum(i.fee_amount), 2), 0),
    min(i.fee_earned_at)
    into item_count, gross_booking_amount, coverage_start
    from public.booking_fee_remittance_items i
   where i.remittance_id = new_id
     and i.released_at is null;

  select
    count(*)::integer,
    coalesce(round(sum(a.amount), 2), 0),
    min(a.effective_at)
    into adjustment_count, adjustment_amount, adjustment_start
    from public.booking_fee_adjustment_applications a
   where a.remittance_id = new_id
     and a.released_at is null;

  total_due := round(gross_booking_amount + adjustment_amount, 2);
  if total_due <= 0 then
    raise exception
      'The month-end cutoff produced no positive payable balance.'
      using errcode = '22023';
  end if;

  coverage_start := case
    when coverage_start is null then adjustment_start
    when adjustment_start is null then coverage_start
    else least(coverage_start, adjustment_start)
  end;

  update public.booking_fee_remittances r
     set bookings_count = item_count,
         amount_due = total_due,
         coverage_start_at = coverage_start,
         status = 'prepared',
         settled_at = null
   where r.id = new_id;

  insert into public.booking_fee_remittance_events (
    remittance_id, event_type, actor_user_id, actor_role, event_at, metadata
  ) values (
    new_id,
    'prepared',
    null,
    'system',
    prepared_time,
    jsonb_build_object(
      'automatic', true,
      'statement_month', to_char(period_end, 'YYYY-MM'),
      'cutoff_at', cutoff_time,
      'bookings_count', item_count,
      'gross_booking_fee_amount', gross_booking_amount,
      'adjustment_count', adjustment_count,
      'adjustment_amount', adjustment_amount,
      'amount_due', total_due
    )
  );

  return new_id;
end;
$$;

revoke all on function public.booking_fee_close_month(timestamptz, timestamptz)
  from public, anon, authenticated;

comment on function public.booking_fee_close_month(timestamptz, timestamptz) is
  'Freezes every unclaimed fee and adjustment through the end of the previous Asia/Manila month into one statement. Idempotent per month; returns null when nothing is payable.';

-- --------------------------------------------------------------------------
-- 3. Manual preparation is retired
-- --------------------------------------------------------------------------

create or replace function public.prepare_booking_fee_remittance(
  p_idempotency_key text,
  p_owner_override boolean default false,
  p_override_due_on date default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception
    'Remittance statements are created automatically at the end of each month.'
    using errcode = '22023';
end;
$$;

comment on function public.prepare_booking_fee_remittance(text, boolean, date, text) is
  'Retired: statements are created automatically by booking_fee_close_month().';

-- --------------------------------------------------------------------------
-- 4. Statements have no due date, so none is ever overdue
-- --------------------------------------------------------------------------

create or replace function public.booking_fee_remittance_summary_json(
  p_remittance_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with all_item_rows as materialized (
    select
      i.booking_ref,
      case
        when nullif(btrim(i.booking_group_ref), '') is not null
          then 'group:' || btrim(i.booking_group_ref)
        else 'booking:' || i.booking_ref
      end as reservation_key,
      i.fee_type,
      i.fee_rate,
      i.fee_units,
      i.fee_amount,
      i.released_at
    from public.booking_fee_remittance_items i
    where i.remittance_id = p_remittance_id
  ),
  item_rows as materialized (
    select * from all_item_rows where released_at is null
  ),
  audit_metrics as (
    select
      count(*)::integer as booking_rows_count,
      count(distinct i.reservation_key)::integer as reservation_count,
      coalesce(
        round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
        0::numeric
      ) as billable_hours,
      (count(*) filter (where i.fee_type = 'flat'))::integer as flat_fee_booking_count,
      coalesce(round(sum(i.fee_amount), 2), 0::numeric) as base_fee_amount
    from item_rows i
  ),
  released_metrics as (
    select
      count(*)::integer as booking_rows_count,
      count(distinct i.reservation_key)::integer as reservation_count,
      coalesce(
        round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
        0::numeric
      ) as billable_hours,
      coalesce(round(sum(i.fee_amount), 2), 0::numeric) as fee_amount
    from all_item_rows i
    where i.released_at is not null
  ),
  rate_breakdown as (
    select coalesce(
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
      ),
      '[]'::jsonb
    ) as rows
    from (
      select
        i.fee_type,
        i.fee_rate,
        count(*)::integer as item_count,
        count(distinct i.reservation_key)::integer as reservation_count,
        round(sum(i.fee_units), 2) as fee_units,
        coalesce(
          round(sum(i.fee_units) filter (where i.fee_type = 'per_hour'), 2),
          0::numeric
        ) as billable_hours,
        (count(*) filter (where i.fee_type = 'flat'))::integer as flat_fee_booking_count,
        round(sum(i.fee_amount), 2) as amount,
        case i.fee_type when 'per_hour' then 1 else 2 end as sort_order
      from item_rows i
      group by i.fee_type, i.fee_rate
    ) x
  ),
  active_adjustments as materialized (
    select a.amount
      from public.booking_fee_adjustment_applications a
     where a.remittance_id = p_remittance_id
       and a.released_at is null
  ),
  adjustment_metrics as (
    select
      count(*)::integer as adjustment_count,
      coalesce(round(sum(a.amount), 2), 0::numeric) as adjustment_amount
    from active_adjustments a
  ),
  released_adjustment_metrics as (
    select
      count(*)::integer as adjustment_count,
      coalesce(round(sum(a.amount), 2), 0::numeric) as adjustment_amount
    from public.booking_fee_adjustment_applications a
    where a.remittance_id = p_remittance_id
      and a.released_at is not null
  )
  select jsonb_build_object(
    'id', r.id,
    'remittance_ref', r.remittance_ref,
    'cycle_due_on', r.cycle_due_on,
    'coverage_start_at', r.coverage_start_at,
    'cutoff_at', r.cutoff_at,
    'status', r.status,
    'currency', r.currency,
    'bookings_count', m.booking_rows_count,
    'booking_rows_count', m.booking_rows_count,
    'reservation_count', m.reservation_count,
    'billable_hours', m.billable_hours,
    'court_hours', m.billable_hours,
    'flat_fee_booking_count', m.flat_fee_booking_count,
    'fee_breakdown', rb.rows,
    'rate_type_breakdown', rb.rows,
    'base_fee_amount', m.base_fee_amount,
    'adjustment_count', am.adjustment_count,
    'adjustment_amount', am.adjustment_amount,
    'calculated_amount_due', round(m.base_fee_amount + am.adjustment_amount, 2),
    'released_booking_rows_count', rm.booking_rows_count,
    'released_reservation_count', rm.reservation_count,
    'released_billable_hours', rm.billable_hours,
    'released_booking_fee_amount', rm.fee_amount,
    'released_adjustment_count', ram.adjustment_count,
    'released_adjustment_amount', ram.adjustment_amount,
    'reconciliation_matches_header', (
      r.status = 'cancelled'
      or round(m.base_fee_amount + am.adjustment_amount, 2) = r.amount_due
    ),
    'amount_due', r.amount_due,
    'amount_settled', r.amount_settled,
    'remaining_balance', case
      when r.status = 'cancelled' then 0::numeric
      else greatest(round(r.amount_due - r.amount_settled, 2), 0)
    end,
    'prepared_at', r.prepared_at,
    'prepared_by_user_id', r.prepared_by_user_id,
    'prepared_by_email', r.prepared_by_email,
    'prepared_by_role', r.prepared_by_role,
    'owner_override', r.owner_override,
    'owner_override_reason', r.owner_override_reason,
    'last_submitted_at', r.last_submitted_at,
    'settled_at', r.settled_at,
    'cancelled_at', r.cancelled_at,
    'cancellation_reason', r.cancellation_reason,
    'latest_payment', (
      select jsonb_build_object(
        'id', p.id,
        'amount_submitted', p.amount_submitted,
        'amount_accepted', p.amount_accepted,
        'payment_method', p.payment_method,
        'payment_reference', p.payment_reference,
        'proof_path', p.proof_path,
        'note', p.note,
        'status', p.status,
        'submitted_at', p.submitted_at,
        'submitted_by_user_id', p.submitted_by_user_id,
        'submitted_by_email', p.submitted_by_email,
        'reviewed_at', p.reviewed_at,
        'reviewed_by_user_id', p.reviewed_by_user_id,
        'review_note', p.review_note
      )
      from public.booking_fee_remittance_payments p
      where p.remittance_id = r.id
      order by p.submitted_at desc, p.id desc
      limit 1
    ),
    'is_overdue', false,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
  from public.booking_fee_remittances r
  cross join audit_metrics m
  cross join released_metrics rm
  cross join rate_breakdown rb
  cross join adjustment_metrics am
  cross join released_adjustment_metrics ram
  where r.id = p_remittance_id
$$;

revoke all on function public.booking_fee_remittance_summary_json(uuid)
  from public, anon, authenticated;

comment on function public.booking_fee_remittance_summary_json(uuid) is
  'Builds payable metrics from active booking and adjustment rows only, while exposing released rows separately for permanent audit.';

-- --------------------------------------------------------------------------
-- 5. Schedule: 00:05 Asia/Manila daily (16:05 UTC). Only the first run after
--    a month ends creates a statement; later runs are no-ops.
-- --------------------------------------------------------------------------

create extension if not exists pg_cron;

do $$
declare
  existing_job bigint;
begin
  select jobid
    into existing_job
    from cron.job
   where jobname = 'close-booking-fee-month'
   limit 1;
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
  perform cron.schedule(
    'close-booking-fee-month',
    '5 16 * * *',
    $job$select public.booking_fee_close_month();$job$
  );
end;
$$;

-- Close October 2026 once, at the exact moment the system owner chose:
-- Nov 1, 2026 1:54 PM PHT, when the dashboard showed ₱8,480.00 accumulating.
-- Fees earned after it belong to November's statement.
select public.booking_fee_close_month(
  '2026-11-01 14:00:00+08',
  '2026-11-01 13:54:59.999999+08'
);

notify pgrst, 'reload schema';

commit;

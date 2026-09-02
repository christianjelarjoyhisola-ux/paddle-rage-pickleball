-- Authoritative, privacy-safe availability snapshot for owner social posts.
-- The browser receives only court names and slot states; customer and payment
-- data never leave this security-definer boundary.

insert into public.settings (key, value, updated_at)
values
  ('open_hour', '6', now()),
  ('close_hour', '22', now()),
  ('maintenance_config', '{"rules":[]}', now())
on conflict (key) do nothing;

create or replace function public.get_admin_availability_graphic(
  p_date date,
  p_court_ids text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ph_now timestamp := timezone('Asia/Manila', statement_timestamp());
  ph_today date;
  open_hour_text text;
  close_hour_text text;
  open_hour integer;
  close_hour integer;
  maintenance_text text;
  maintenance_config jsonb;
  maintenance_rules jsonb := '[]'::jsonb;
  whole_date_blocked boolean := false;
  courts_payload jsonb := '[]'::jsonb;
  court_payload jsonb;
  slots_payload jsonb;
  court_row record;
  slot_hour integer;
  slot_state text;
  slot_reason text;
  slot_label text;
  available_count integer;
  maintenance_rule jsonb;
  rule_start integer;
  rule_end integer;
  rule_date date;
  rule_mode text;
  rule_matches boolean;
begin
  if auth.uid() is null
     or not exists (
       select 1
         from public.accounts account
        where account.id = auth.uid()
          and account.status = 'active'
          and account.role in ('owner', 'court_owner')
     ) then
    raise exception 'An active Paddle Rage owner account is required.'
      using errcode = '42501';
  end if;

  ph_today := ph_now::date;
  if p_date is null
     or p_date < ph_today
     or p_date > ph_today + 366 then
    raise exception 'Availability date must be within the next 366 Manila calendar days.'
      using errcode = '22023';
  end if;

  if coalesce(cardinality(p_court_ids), 0) > 50
     or exists (
       select 1
       from unnest(coalesce(p_court_ids, '{}'::text[])) requested(id)
       where nullif(btrim(requested.id), '') is null
     ) then
    raise exception 'Court selection is invalid.' using errcode = '22023';
  end if;

  select s.value into open_hour_text
    from public.settings s where s.key = 'open_hour' limit 1;

  select s.value into close_hour_text
    from public.settings s where s.key = 'close_hour' limit 1;

  if btrim(coalesce(open_hour_text, '')) !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
     or btrim(coalesce(close_hour_text, '')) !~ '^(?:[1-9]|1[0-9]|2[0-4])$' then
    raise exception 'Court operating hours are not configured correctly.'
      using errcode = '23514';
  end if;
  open_hour := btrim(open_hour_text)::integer;
  close_hour := btrim(close_hour_text)::integer;
  if close_hour <= open_hour then
    raise exception 'Court operating hours are not configured correctly.'
      using errcode = '23514';
  end if;

  select s.value into maintenance_text
    from public.settings s where s.key = 'maintenance_config' limit 1;
  begin
    maintenance_config := maintenance_text::jsonb;
  exception when others then
    raise exception 'Maintenance schedule is not configured correctly.'
      using errcode = '23514';
  end;
  if maintenance_config is null or jsonb_typeof(maintenance_config) <> 'object' then
    raise exception 'Maintenance schedule is not configured correctly.'
      using errcode = '23514';
  end if;
  if maintenance_config ? 'rules'
     and jsonb_typeof(maintenance_config->'rules') <> 'array' then
    raise exception 'Maintenance schedule is not configured correctly.'
      using errcode = '23514';
  elsif jsonb_typeof(maintenance_config->'rules') = 'array' then
    maintenance_rules := maintenance_config->'rules';
  elsif maintenance_config <> '{}'::jsonb then
    maintenance_rules := jsonb_build_array(maintenance_config);
  end if;

  if coalesce(cardinality(p_court_ids), 0) > 0
     and (
       select count(distinct c.id)
         from public.courts c
        where coalesce(c.blocked, false) = false
          and c.id = any(p_court_ids)
     ) <> (
       select count(distinct requested.id)
         from unnest(p_court_ids) requested(id)
     ) then
    raise exception 'One or more selected courts are unavailable.'
      using errcode = '22023';
  end if;

  select exists (
    select 1 from public.blocked_dates blocked where blocked.date = p_date
  ) into whole_date_blocked;

  for court_row in
    select c.id, c.name
      from public.courts c
     where coalesce(c.blocked, false) = false
       and (
         coalesce(cardinality(p_court_ids), 0) = 0
         or c.id = any(p_court_ids)
       )
     order by c.id
  loop
    slots_payload := '[]'::jsonb;
    available_count := 0;

    for slot_hour in open_hour..(close_hour - 1)
    loop
      slot_state := 'free';
      slot_reason := null;
      slot_label := 'Available';

      if p_date < date '2026-09-19' then
        slot_state := 'unavailable';
        slot_reason := 'pre_opening';
        slot_label := 'Not open yet';
      elsif whole_date_blocked then
        slot_state := 'unavailable';
        slot_reason := 'blocked_date';
        slot_label := 'Closed';
      elsif p_date = ph_today and slot_hour < extract(hour from ph_now)::integer then
        slot_state := 'unavailable';
        slot_reason := 'past';
        slot_label := 'Past';
      elsif p_date = ph_today and slot_hour = extract(hour from ph_now)::integer then
        slot_state := 'unavailable';
        slot_reason := 'current';
        slot_label := 'In progress';
      elsif exists (
        select 1
          from public.bookings b
         where b.court_id = court_row.id
           and b.date = p_date
           and public.booking_occupies_slot(
             b.status,
             b.email,
             b.full_name,
             b.created_at
           )
           and exists (
             select 1
               from unnest(coalesce(b.slots, '{}'::text[])) booked(slot_value)
              where booked.slot_value ~ '^(?:[0-9]|1[0-9]|2[0-3])$'
                and booked.slot_value::integer = slot_hour
           )
      ) then
        slot_state := 'unavailable';
        slot_reason := 'booked';
        slot_label := 'Booked';
      else
        for maintenance_rule in
          select rule.value
            from jsonb_array_elements(maintenance_rules) rule(value)
        loop
          rule_matches := false;
          if jsonb_typeof(maintenance_rule) <> 'object' then
            raise exception 'Maintenance schedule is not configured correctly.'
              using errcode = '23514';
          end if;
          if lower(coalesce(maintenance_rule->>'enabled', 'false')) not in ('true', '1', 'false', '0') then
            raise exception 'Maintenance schedule is not configured correctly.'
              using errcode = '23514';
          end if;
          if lower(coalesce(maintenance_rule->>'enabled', 'false')) not in ('true', '1') then
            continue;
          end if;
          if btrim(coalesce(maintenance_rule->>'start', '')) !~ '^(?:[0-9]|1[0-9]|2[0-3])$'
             or btrim(coalesce(maintenance_rule->>'end', '')) !~ '^(?:[0-9]|1[0-9]|2[0-4])$'
             or (maintenance_rule ? 'courtIds' and jsonb_typeof(maintenance_rule->'courtIds') <> 'array')
             or lower(coalesce(maintenance_rule->>'mode', 'specific')) not in ('specific', 'weekly', 'monthly') then
            raise exception 'Maintenance schedule is not configured correctly.'
              using errcode = '23514';
          end if;

          rule_start := btrim(maintenance_rule->>'start')::integer;
          rule_end := btrim(maintenance_rule->>'end')::integer;
          if rule_start = rule_end
             or not (
               (rule_start < rule_end and slot_hour >= rule_start and slot_hour < rule_end)
               or (rule_start > rule_end and (slot_hour >= rule_start or slot_hour < rule_end))
             ) then
            continue;
          end if;

          if jsonb_typeof(maintenance_rule->'courtIds') = 'array'
             and jsonb_array_length(maintenance_rule->'courtIds') > 0
             and not exists (
               select 1
                 from jsonb_array_elements_text(maintenance_rule->'courtIds') configured(id)
                where configured.id = court_row.id
             ) then
            continue;
          end if;

          -- Match the live customer/admin booking surfaces: overnight ranges
          -- wrap by hour but remain attached to the selected calendar date.
          rule_date := p_date;
          rule_mode := lower(coalesce(maintenance_rule->>'mode', 'specific'));

          if rule_mode = 'specific' then
            if jsonb_typeof(maintenance_rule->'dates') is distinct from 'array' then
              raise exception 'Maintenance schedule is not configured correctly.'
                using errcode = '23514';
            end if;
            rule_matches := jsonb_typeof(maintenance_rule->'dates') = 'array'
              and exists (
                select 1
                  from jsonb_array_elements_text(maintenance_rule->'dates') configured(value)
                 where configured.value = rule_date::text
              );
          elsif rule_mode = 'weekly' then
            if jsonb_typeof(maintenance_rule#>'{recurring,days}') is distinct from 'array'
               or exists (
                 select 1
                   from jsonb_array_elements_text(maintenance_rule#>'{recurring,days}') configured(value)
                  where configured.value !~ '^[0-6]$'
               ) then
              raise exception 'Maintenance schedule is not configured correctly.'
                using errcode = '23514';
            end if;
            rule_matches := jsonb_typeof(maintenance_rule#>'{recurring,days}') = 'array'
              and exists (
                select 1
                  from jsonb_array_elements_text(maintenance_rule#>'{recurring,days}') configured(value)
                 where configured.value ~ '^[0-6]$'
                   and configured.value::integer = extract(dow from rule_date)::integer
              );
          elsif rule_mode = 'monthly' then
            if btrim(coalesce(maintenance_rule#>>'{recurring,day}', '')) !~ '^(?:[1-9]|[12][0-9]|3[01])$' then
              raise exception 'Maintenance schedule is not configured correctly.'
                using errcode = '23514';
            end if;
            rule_matches := btrim(coalesce(maintenance_rule#>>'{recurring,day}', '')) ~ '^(?:[1-9]|[12][0-9]|3[01])$'
              and btrim(maintenance_rule#>>'{recurring,day}')::integer = extract(day from rule_date)::integer;
          end if;

          if rule_matches then
            slot_state := 'unavailable';
            slot_reason := 'maintenance';
            slot_label := case lower(coalesce(maintenance_rule->>'label', 'maintenance'))
              when 'closed' then 'Closed'
              when 'reserved' then 'Reserved'
              when 'blocked' then 'Blocked'
              when 'private' then 'Private Event'
              when 'group' then 'Group Session'
              when 'openplay' then 'Open Play'
              else 'Maintenance'
            end;
            exit;
          end if;
        end loop;

      end if;

      if slot_state = 'free' then
        available_count := available_count + 1;
      end if;

      slots_payload := slots_payload || jsonb_build_array(jsonb_build_object(
        'hour', slot_hour,
        'startHour', slot_hour,
        'endHour', slot_hour + 1,
        'startLabel', to_char(time '00:00' + (slot_hour % 24) * interval '1 hour', 'FMHH12:MI AM'),
        'endLabel', to_char(time '00:00' + ((slot_hour + 1) % 24) * interval '1 hour', 'FMHH12:MI AM'),
        'state', slot_state,
        'reason', slot_reason,
        'label', slot_label
      ));
    end loop;

    court_payload := jsonb_build_object(
      'id', court_row.id,
      'name', court_row.name,
      'availableCount', available_count,
      'totalSlots', close_hour - open_hour,
      'slots', slots_payload
    );
    courts_payload := courts_payload || jsonb_build_array(court_payload);
  end loop;

  if jsonb_array_length(courts_payload) = 0 then
    raise exception 'No active courts are available for this snapshot.'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'version', 1,
    'date', p_date::text,
    'timezone', 'Asia/Manila',
    'asOf', to_char(ph_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+08:00',
    'openHour', open_hour,
    'closeHour', close_hour,
    'courts', courts_payload
  );
end;
$$;

comment on function public.get_admin_availability_graphic(date, text[]) is
  'Owner-only privacy-safe court availability snapshot for social graphics. Uses canonical booking occupancy plus blocked-date, maintenance, opening-date, and Manila-clock rules.';

revoke all on function public.get_admin_availability_graphic(date, text[])
  from public, anon;
grant execute on function public.get_admin_availability_graphic(date, text[])
  to authenticated, service_role;

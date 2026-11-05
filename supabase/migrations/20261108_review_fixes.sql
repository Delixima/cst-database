-- =============================================================================
-- Migration 2026-11-08: code review fixes
--
-- D1  ⧭ approval only applies to arrests: the trigger drops the approver on any
--     other action; dashboard "pending approvals" counts arrests only.
-- D2  Members can change their own Roblox username only while pending.
-- D3  Per-IP sign-in limit prefers cf-connecting-ip / x-real-ip over the
--     client-controlled first X-Forwarded-For entry.
-- D4  public.update_member(): profile + memberships in one transaction.
--
-- Run ONCE in the Supabase SQL Editor, after 20261107_username_login.sql.
-- A fresh install does not need this file: schema.sql already contains it.
-- =============================================================================

begin;

create or replace function private.profiles_before_update()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_system boolean := private.is_system_context();
begin
  if new.id <> old.id or new.created_at <> old.created_at then
    raise exception 'Read-only fields (id, created_at).' using errcode = '42501';
  end if;

  if not v_system and not private.is_manager() then
    if auth.uid() is distinct from old.id then
      raise exception 'You can only edit your own profile.' using errcode = '42501';
    end if;
    if (new.role, new.active, new.rank_id, new.service_number)
       is distinct from (old.role, old.active, old.rank_id, old.service_number) then
      raise exception 'Only the manager can change the role, status, rank or service number.'
        using errcode = '42501';
    end if;
    -- Members set their own username only while pending (sign-up fix-up).
    -- Once approved, the identity shown on every log is managed by the manager.
    if new.roblox_username is distinct from old.roblox_username and old.role <> 'pending' then
      raise exception 'Your Roblox username can only be changed by the manager once your account is approved.'
        using errcode = '42501';
    end if;
  end if;

  if old.role = 'manager' and old.active and (new.role <> 'manager' or not new.active) then
    if not exists (
      select 1 from public.profiles p
      where p.role = 'manager' and p.active and p.id <> old.id
    ) then
      raise exception 'The last active manager cannot be removed.' using errcode = '23514';
    end if;
  end if;

  new.roblox_username := nullif(btrim(new.roblox_username), '');
  new.service_number  := nullif(btrim(new.service_number), '');
  new.updated_at      := now();
  return new;
end;
$$;

create or replace function private.sanction_logs_before_write()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_system        boolean := private.is_system_context();
  v_uid           uuid := auth.uid();
  v_role          public.app_role := private.current_app_role();
  v_level         integer := private.role_level(private.current_app_role());
  v_offense       public.offenses%rowtype;
  v_rec           record;
  v_year          integer;
  v_seq           integer;
  v_recompute     boolean := false;
  v_only_approval boolean := false;
  v_last_reset    timestamptz;
  v_approver_role public.app_role;
begin
  ---------------------------------------------------------------------------
  -- A. Permissions & server-owned fields
  ---------------------------------------------------------------------------
  if tg_op = 'INSERT' then
    if not v_system then
      if v_level < 2 then
        raise exception 'Your role cannot create logs.' using errcode = '42501';
      end if;
      if new.agent_id is null then
        new.agent_id := v_uid;
      end if;
      if new.agent_id <> v_uid and v_level < 4 then
        raise exception 'Only officers can log on behalf of another agent.' using errcode = '42501';
      end if;
    end if;

    new.created_by            := coalesce(v_uid, new.agent_id);
    new.status                := 'valid';
    new.void_reason           := null;
    new.voided_by             := null;
    new.voided_at             := null;
    new.deleted_at            := null;
    new.counts_for_warnings   := true;
    new.approval_confirmed_by := null;
    new.approval_confirmed_at := null;
    new.created_at            := now();
    new.updated_at            := now();

    v_year := extract(year from (now() at time zone 'utc'))::integer;
    insert into private.log_counters as c (year, last_value)
    values (v_year, 1)
    on conflict (year) do update set last_value = c.last_value + 1
    returning c.last_value into v_seq;
    new.log_number := 'LOG-' || v_year::text || '-' || lpad(v_seq::text, greatest(5, length(v_seq::text)), '0');

    v_recompute := true;

  else -- UPDATE
    if new.id <> old.id or new.log_number <> old.log_number
       or new.created_at <> old.created_at or new.created_by <> old.created_by then
      raise exception 'Read-only fields (id, number, creation date, creator).' using errcode = '42501';
    end if;

    -- Is this update only an approval confirmation?
    v_only_approval :=
      (to_jsonb(new) - 'approval_confirmed_by' - 'approval_confirmed_at' - 'updated_at')
      = (to_jsonb(old) - 'approval_confirmed_by' - 'approval_confirmed_at' - 'updated_at');

    if not v_system then
      if v_level < 2 then
        raise exception 'Your role cannot edit logs.' using errcode = '42501';
      end if;
      if old.deleted_at is not null and v_level < 5 then
        raise exception 'This log is deleted.' using errcode = '42501';
      end if;

      if v_only_approval then
        if v_level < 3 then
          raise exception 'Only a CS, an officer or the manager can confirm an approval.' using errcode = '42501';
        end if;
      else
        if v_role = 'trooper' and (old.agent_id <> v_uid or old.created_at < now() - interval '24 hours') then
          raise exception 'A trooper can only edit their own logs less than 24 h old.' using errcode = '42501';
        end if;
        if v_role = 'cs' and old.agent_id <> v_uid and not private.same_squad(old.agent_id) then
          raise exception 'A CS can only edit their own logs and those of their squads.' using errcode = '42501';
        end if;
        if new.deleted_at is distinct from old.deleted_at and v_level < 5 then
          raise exception 'Only the manager can delete or undelete a log.' using errcode = '42501';
        end if;
        if new.agent_id <> old.agent_id and v_level < 4 then
          raise exception 'Only officers can change the agent of a log.' using errcode = '42501';
        end if;
        if new.status <> old.status and v_level < 4 then
          raise exception 'Only officers and the manager can void or restore a log.' using errcode = '42501';
        end if;
        if new.counts_for_warnings <> old.counts_for_warnings and v_level < 4 then
          raise exception 'Only officers and the manager can reset warnings.' using errcode = '42501';
        end if;
      end if;

      if (new.approval_confirmed_by is distinct from old.approval_confirmed_by)
         or (new.approval_confirmed_at is distinct from old.approval_confirmed_at) then
        if v_level < 3 then
          raise exception 'Only a CS, an officer or the manager can confirm an approval.' using errcode = '42501';
        end if;
        if new.approval_confirmed_by is not null and new.approval_confirmed_by <> v_uid then
          raise exception 'You can only confirm an approval in your own name.' using errcode = '42501';
        end if;
      end if;
    end if;

    if new.approval_confirmed_by is distinct from old.approval_confirmed_by then
      new.approval_confirmed_at := case when new.approval_confirmed_by is null then null else now() end;
    end if;

    -- Void / restore bookkeeping
    if new.status = 'voided' and old.status = 'valid' then
      new.void_reason := nullif(btrim(new.void_reason), '');
      if new.void_reason is null or char_length(new.void_reason) < 3 then
        raise exception 'A void reason (3 characters minimum) is required.' using errcode = '23514';
      end if;
      new.voided_by := v_uid;
      new.voided_at := now();
    elsif new.status = 'valid' and old.status = 'voided' then
      new.void_reason := null;
      new.voided_by   := null;
      new.voided_at   := null;
    else
      new.void_reason := old.void_reason;
      new.voided_by   := old.voided_by;
      new.voided_at   := old.voided_at;
    end if;

    new.updated_at := now();

    -- Not recomputed on a merge (target_normalized only) or a reset: history keeps its numbers.
    v_recompute :=
         new.offense_id      is distinct from old.offense_id
      or new.target_username is distinct from old.target_username
      or new.occurred_at     is distinct from old.occurred_at
      or new.action_taken    is distinct from old.action_taken
      or new.order_type      is distinct from old.order_type;
  end if;

  ---------------------------------------------------------------------------
  -- B. Normalization
  ---------------------------------------------------------------------------
  new.target_username := btrim(new.target_username);
  if not private.is_valid_username(new.target_username) then
    raise exception 'Invalid Roblox username (3 to 20 characters: letters, digits, _).' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' or new.target_username is distinct from old.target_username then
    new.target_normalized := private.resolve_player(new.target_username);
  elsif new.target_normalized is distinct from old.target_normalized and not (v_system or v_level >= 5) then
    -- Only the manager (merge) may move a log to another player record
    new.target_normalized := old.target_normalized;
  end if;

  new.location        := nullif(btrim(new.location), '');
  new.notes           := nullif(btrim(new.notes), '');
  new.ordered_by      := nullif(btrim(new.ordered_by), '');
  new.override_reason := nullif(btrim(new.override_reason), '');
  new.evidence_urls   := coalesce(
    array(select btrim(u) from unnest(new.evidence_urls) as u where u is not null and btrim(u) <> ''),
    '{}'::text[]
  );

  if new.occurred_at is null then
    new.occurred_at := now();
  end if;
  if new.occurred_at > now() + interval '5 minutes' then
    raise exception 'The incident date cannot be in the future.' using errcode = '23514';
  end if;

  if new.order_type <> 'none' and new.ordered_by is null then
    raise exception 'Enter who gave the order (e.g. HICOM, ISB, officer username).' using errcode = '23514';
  end if;

  ---------------------------------------------------------------------------
  -- C. Offense consistency
  ---------------------------------------------------------------------------
  select * into v_offense from public.offenses where id = new.offense_id;
  if not found then
    raise exception 'Unknown offense.' using errcode = '23503';
  end if;
  if not v_offense.active and (tg_op = 'INSERT' or new.offense_id <> old.offense_id) then
    raise exception 'Offense % is inactive.', v_offense.code using errcode = '23514';
  end if;

  new.procedure := v_offense.procedure;

  if v_offense.target <> 'both' and new.order_type <> 'hicom_isb_order' then
    -- Target type is implied by the offense (HICOM/ISB orders may target anyone)
    new.target_type := v_offense.target::text::public.target_type;
  elsif new.target_type is null then
    raise exception 'Specify the target type (personnel or immigrant).' using errcode = '23502';
  end if;

  ---------------------------------------------------------------------------
  -- D. Recommendation engine, warning numbering, override detection
  ---------------------------------------------------------------------------
  if v_recompute then
    -- Serialize concurrent writes for the same (player, offense)
    perform pg_advisory_xact_lock(hashtextextended(new.target_normalized || ':' || new.offense_id::text, 0));

    select * into v_rec
    from private.compute_recommendation(
      new.target_normalized, new.offense_id, new.occurred_at, new.order_type,
      case when tg_op = 'UPDATE' then new.id end
    );

    new.prior_warnings             := v_rec.prior_warnings;
    new.recommended_action         := v_rec.recommended_action;
    new.recommendation_code        := v_rec.recommendation_code;
    new.recommended_warning_number := v_rec.recommended_warning_number;

    if new.action_taken = 'warning'
       or (new.action_taken = 'relocation' and v_offense.default_action = 'relocation') then
      new.warning_number := v_rec.prior_warnings + 1;
    else
      new.warning_number := null;
    end if;

    new.is_override := new.action_taken <> new.recommended_action;

    -- A backdated log that predates a reset does not count
    if tg_op = 'INSERT' then
      select max(r.created_at) into v_last_reset
      from public.warning_resets r
      where r.target_normalized = new.target_normalized
        and (r.offense_id is null or r.offense_id = new.offense_id);
      if v_last_reset is not null and new.occurred_at <= v_last_reset then
        new.counts_for_warnings := false;
      end if;
    end if;
  end if;

  if new.action_taken in ('arrest', 'detention') then
    if new.jail_seconds is null then
      new.jail_seconds := v_offense.jail_seconds;
    end if;
  else
    new.jail_seconds := null;
  end if;

  if new.is_override and new.order_type = 'none' and new.override_reason is null then
    raise exception 'The chosen action differs from the recommended action: a justification is required.'
      using errcode = '23514';
  end if;

  ---------------------------------------------------------------------------
  -- E. ⧭ approval: arrest on an approval-required offense needs a CS+ approver
  ---------------------------------------------------------------------------
  -- An approval only makes sense for an arrest: drop it for any other action.
  if new.action_taken <> 'arrest' then
    new.approved_by           := null;
    new.approval_confirmed_by := null;
    new.approval_confirmed_at := null;
  end if;

  if tg_op = 'INSERT' or new.approved_by is distinct from old.approved_by then
    if new.approved_by is not null then
      select p.role into v_approver_role
      from public.profiles p
      where p.id = new.approved_by and p.active;
      if private.role_level(v_approver_role) < 3 then
        raise exception 'The approver must be an active Company Sergeant, officer or manager.'
          using errcode = '23514';
      end if;
    end if;
    -- Self-approval by a CS+ is confirmed at once; otherwise confirmation resets
    if new.approved_by is not null and new.approved_by = v_uid then
      new.approval_confirmed_by := v_uid;
      new.approval_confirmed_at := now();
    elsif tg_op = 'UPDATE' then
      new.approval_confirmed_by := null;
      new.approval_confirmed_at := null;
    end if;
  end if;

  if v_offense.requires_cs_approval
     and new.action_taken = 'arrest'
     and new.status = 'valid'
     and new.approved_by is null then
    raise exception '⧭ offense %: an arrest requires approval from a Company Sergeant or above.', v_offense.code
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function public.dashboard_stats(p_tz text default 'UTC')
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_tz          text;
  v_local_now   timestamp;
  v_day_start   timestamptz;
  v_week_start  timestamptz;
  v_month_start timestamptz;
  v_result      jsonb;
begin
  if not private.is_reader() then
    raise exception 'Access denied.' using errcode = '42501';
  end if;

  v_tz := case when exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then p_tz else 'UTC' end;
  v_local_now   := now() at time zone v_tz;
  v_day_start   := date_trunc('day',   v_local_now) at time zone v_tz;
  v_week_start  := date_trunc('week',  v_local_now) at time zone v_tz;
  v_month_start := date_trunc('month', v_local_now) at time zone v_tz;

  with base as (
    select l.*
    from public.sanction_logs l
    where l.deleted_at is null
      and l.status = 'valid'
  )
  select jsonb_build_object(
    'timezone',    v_tz,
    'today',       (select count(*) from base where occurred_at >= v_day_start),
    'week',        (select count(*) from base where occurred_at >= v_week_start),
    'month',       (select count(*) from base where occurred_at >= v_month_start),
    'actions_week', (
      select coalesce(jsonb_object_agg(s.action_taken, s.total), '{}'::jsonb)
      from (select action_taken, count(*) as total from base where occurred_at >= v_week_start group by action_taken) s
    ),
    'actions_month', (
      select coalesce(jsonb_object_agg(s.action_taken, s.total), '{}'::jsonb)
      from (select action_taken, count(*) as total from base where occurred_at >= v_month_start group by action_taken) s
    ),
    'top_offenses_month', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.total desc, t.code), '[]'::jsonb)
      from (
        select o.id, o.code, o.name, o.procedure, count(*) as total
        from base b
        join public.offenses o on o.id = b.offense_id
        where b.occurred_at >= v_month_start
        group by o.id
        order by count(*) desc, o.code
        limit 10
      ) t
    ),
    'agents_month', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.total desc, t.roblox_username), '[]'::jsonb)
      from (
        select p.id, p.roblox_username, count(*) as total,
               count(*) filter (where b.action_taken = 'arrest')      as arrests,
               count(*) filter (where b.action_taken = 'warning')     as warnings,
               count(*) filter (where b.action_taken = 'termination') as terminations
        from base b
        join public.profiles p on p.id = b.agent_id
        where b.occurred_at >= v_month_start
        group by p.id
        order by count(*) desc
        limit 15
      ) t
    ),
    'pending_approvals', case when private.is_cs_plus() then (
      select count(*) from base
      where action_taken = 'arrest' and approved_by is not null and approval_confirmed_at is null
    ) end,
    'reports_pending', (
      select count(*)
      from base b
      join public.offenses o on o.id = b.offense_id
      where o.report_required
        and not b.report_filed
        and b.action_taken in ('arrest', 'termination')
    )
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.resolve_login_email(p_identifier text, p_password text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id    text := lower(btrim(coalesce(p_identifier, '')));
  v_ip    text;
  v_email text;
  v_hash  text;
begin
  if v_id !~ '^[a-z0-9_]{3,20}$' or p_password is null or char_length(p_password) not between 1 and 200 then
    return jsonb_build_object('email', null);
  end if;

  -- Client IP for the per-IP limit. Prefer headers set by the edge proxy
  -- (Cloudflare overwrites cf-connecting-ip, so a client cannot spoof it);
  -- the first X-Forwarded-For entry is client-controlled and only a fallback.
  -- The per-username limit does not depend on the IP at all.
  begin
    declare
      v_headers json := nullif(current_setting('request.headers', true), '')::json;
    begin
      v_ip := coalesce(
        nullif(btrim(v_headers ->> 'cf-connecting-ip'), ''),
        nullif(btrim(v_headers ->> 'x-real-ip'), ''),
        nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '')
      );
    end;
  exception when others then
    v_ip := null;
  end;
  v_ip := left(v_ip, 64);

  delete from private.login_attempts where attempted_at < now() - interval '1 day';

  if (select count(*) from private.login_attempts
       where identifier = v_id and attempted_at > now() - interval '15 minutes') >= 5
     or (v_ip is not null and (select count(*) from private.login_attempts
       where ip = v_ip and attempted_at > now() - interval '15 minutes') >= 20) then
    return jsonb_build_object('locked', true);
  end if;

  select u.email, u.encrypted_password into v_email, v_hash
  from public.profiles p
  join auth.users u on u.id = p.id
  where lower(p.roblox_username) = v_id;

  if v_hash is not null and v_hash <> '' then
    if extensions.crypt(p_password, v_hash) = v_hash then
      delete from private.login_attempts where identifier = v_id;
      return jsonb_build_object('email', v_email);
    end if;
  else
    -- Unknown username: spend the same bcrypt time so it cannot be detected by timing
    perform extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  end if;

  insert into private.login_attempts (identifier, ip) values (v_id, v_ip);
  return jsonb_build_object('email', null);
end;
$$;

create or replace function public.update_member(
  p_profile_id      uuid,
  p_roblox_username text,
  p_service_number  text,
  p_role            public.app_role,
  p_rank_id         uuid,
  p_active          boolean,
  p_unit_ids        uuid[]
)
returns void
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_units uuid[] := coalesce(p_unit_ids, '{}'::uuid[]);
begin
  if not private.is_manager() then
    raise exception 'Only the manager can edit members.' using errcode = '42501';
  end if;

  update public.profiles
     set roblox_username = nullif(btrim(p_roblox_username), ''),
         service_number  = nullif(btrim(p_service_number), ''),
         role            = p_role,
         rank_id         = p_rank_id,
         active          = coalesce(p_active, true)
   where id = p_profile_id;
  if not found then
    raise exception 'Member not found.' using errcode = 'P0002';
  end if;

  delete from public.profile_squads
   where profile_id = p_profile_id
     and squad_id <> all (v_units);

  insert into public.profile_squads (profile_id, squad_id)
  select p_profile_id, u
  from unnest(v_units) as u
  on conflict (profile_id, squad_id) do nothing;
end;
$$;

revoke all on function public.update_member(uuid, text, text, public.app_role, uuid, boolean, uuid[]) from public, anon;
grant execute on function public.update_member(uuid, text, text, public.app_role, uuid, boolean, uuid[]) to authenticated;

-- D1 data clean-up: approvers recorded on non-arrest logs (audited by trigger)
update public.sanction_logs
   set approved_by = null
 where action_taken <> 'arrest'
   and approved_by is not null;

commit;

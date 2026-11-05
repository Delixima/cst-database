-- =============================================================================
-- Migration 2026-11-06: multiple squads per member + functions
--
-- * squads.kind: 'squad' (team) or 'function' (Internal Affairs, Instructor...)
-- * profile_squads: many-to-many memberships, replaces profiles.squad_id
--   (existing assignments are copied before the column is dropped)
-- * A CS may edit logs of members sharing at least one active squad
--   (kind = 'squad'). Functions grant no extra rights.
-- * sanction_logs_expanded.agent_squad_id -> agent_squad_ids (uuid[])
--
-- Run ONCE in the Supabase SQL Editor, after 20261105_english_messages.sql.
-- A fresh install does not need this file: schema.sql already contains it.
-- =============================================================================

begin;

-- 1. Unit kind
alter table public.squads
  add column kind text not null default 'squad' check (kind in ('squad', 'function'));

-- 2. Memberships
create table public.profile_squads (
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  squad_id    uuid not null references public.squads (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (profile_id, squad_id)
);
create index profile_squads_squad_idx on public.profile_squads (squad_id);

insert into public.profile_squads (profile_id, squad_id)
select id, squad_id from public.profiles where squad_id is not null;

-- 3. Drop the single-squad column (the view depends on it)
drop view public.sanction_logs_expanded;
alter table public.profiles drop column squad_id;

-- 4. Functions
create or replace function private.audit_row_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;

  -- Skip no-op updates (only updated_at changed)
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return null;
  end if;

  insert into public.audit_log (user_id, action, table_name, row_id, old_data, new_data)
  values (auth.uid(), tg_op, tg_table_name, coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'profile_id', v_old ->> 'profile_id'), v_old, v_new);
  return null;
end;
$$;

create or replace function private.same_squad(p_agent uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profile_squads a
    join public.profile_squads me on me.squad_id = a.squad_id and me.profile_id = auth.uid()
    join public.squads s on s.id = a.squad_id
    where a.profile_id = p_agent
      and s.kind = 'squad'
      and s.active
  )
$$;

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

-- 5. View
create view public.sanction_logs_expanded
with (security_invoker = true)
as
select
  l.*,
  o.code                  as offense_code,
  o.name                  as offense_name,
  o.requires_cs_approval  as offense_requires_cs_approval,
  o.report_required       as offense_report_required,
  o.max_warnings          as offense_max_warnings,
  ag.roblox_username      as agent_username,
  ag.service_number       as agent_service_number,
  coalesce((select array_agg(ps.squad_id)
              from public.profile_squads ps
              join public.squads s on s.id = ps.squad_id
             where ps.profile_id = l.agent_id and s.kind = 'squad' and s.active),
           '{}'::uuid[])  as agent_squad_ids,
  ap.roblox_username      as approver_username,
  cf.roblox_username      as approval_confirmed_by_username,
  vb.roblox_username      as voided_by_username,
  cb.roblox_username      as created_by_username
from public.sanction_logs l
join public.offenses o       on o.id  = l.offense_id
left join public.profiles ag on ag.id = l.agent_id
left join public.profiles ap on ap.id = l.approved_by
left join public.profiles cf on cf.id = l.approval_confirmed_by
left join public.profiles vb on vb.id = l.voided_by
left join public.profiles cb on cb.id = l.created_by;

-- 6. Audit, RLS, grants
create trigger audit_profile_squads after insert or update or delete on public.profile_squads
  for each row execute function private.audit_row_change();

alter table public.profile_squads enable row level security;
create policy profile_squads_select on public.profile_squads for select to authenticated
  using ((select private.is_reader()) or profile_id = (select auth.uid()));
create policy profile_squads_insert on public.profile_squads for insert to authenticated
  with check ((select private.is_manager()));
create policy profile_squads_delete on public.profile_squads for delete to authenticated
  using ((select private.is_manager()));

revoke all on public.profile_squads from anon;
grant select, insert, delete on public.profile_squads to authenticated;
grant select on public.sanction_logs_expanded to authenticated;
revoke all on public.sanction_logs_expanded from anon;

-- 7. Example functions
insert into public.squads (name, kind)
select v.name, 'function'
from (values ('Internal Affairs'), ('Instructor')) as v(name)
where not exists (select 1 from public.squads s where lower(s.name) = lower(v.name));

commit;

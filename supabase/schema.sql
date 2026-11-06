-- =============================================================================
-- CST Sanction Logs - Supabase schema
-- Coruscant Shock Troopers - sanction log registry
--
-- Run ONCE, as-is, in the Supabase SQL Editor of a fresh project.
-- Everything runs in a single transaction: if anything fails, nothing is kept.
--
-- Contents
--   0. Schemas & extensions
--   1. Enum types
--   2. Pure helper functions (used by CHECK constraints)
--   3. Tables
--   4. Indexes
--   5. Role helper functions (used by RLS policies)
--   6. Business logic (warning recommendation engine)
--   7. Triggers
--   8. Views
--   9. RPC functions (callable from the front with supabase.rpc)
--  10. Row Level Security policies
--  11. Grants
--  12. Seed data
--
-- Security model
--   * Every table has RLS enabled and at least one policy.
--   * Column-level rules (who may void, delete, re-assign, reset...) are
--     enforced by BEFORE triggers, so they hold even if the front is bypassed.
--   * Internal helpers live in the "private" schema, which is NOT exposed by
--     the Supabase REST API.
--   * "System context" = SQL Editor / service_role (no end-user JWT). Triggers
--     skip end-user permission checks in that context so the owner can do
--     maintenance; business validation still applies.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Schemas & extensions
-- -----------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- 1. Enum types
-- -----------------------------------------------------------------------------
-- manager, officer, cs = Company Sergeant, trooper, read_only, pending
create type public.app_role as enum ('manager', 'officer', 'cs', 'trooper', 'read_only', 'pending');

create type public.procedure_code as enum ('alpha', 'foxtrot', 'tango', 'delta', 'lima', 'hotel', 'sierra');

-- Who an offense applies to
create type public.offense_target as enum ('personnel', 'immigrant', 'both');

-- Who the sanctioned player actually was
create type public.target_type as enum ('personnel', 'immigrant');

-- relocation = cuff out
create type public.sanction_action as enum ('warning', 'arrest', 'termination', 'relocation', 'search', 'detention');

create type public.order_type as enum ('none', 'arrest_on_sight', 'kill_on_sight', 'hicom_isb_order');

create type public.log_status as enum ('valid', 'voided');

-- -----------------------------------------------------------------------------
-- 2. Pure helper functions (immutable, safe for CHECK constraints)
-- -----------------------------------------------------------------------------

-- Roblox usernames: 3-20 chars, letters, digits, underscore.
create function private.is_valid_username(p text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p is not null and p ~ '^[A-Za-z0-9_]{3,20}$'
$$;

create function private.normalize_username(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select lower(btrim(p))
$$;

-- Evidence: at most 10 URLs, https only, no whitespace / quotes / angle brackets.
create function private.valid_evidence_urls(urls text[])
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(array_length(urls, 1), 0) <= 10
     and not exists (
       select 1
       from unnest(urls) as u
       where u is null
          or char_length(u) not between 12 and 2048
          or u !~ '^https://[^[:space:]<>"''`]+$'
     )
$$;

-- Hierarchy level of a role (higher = more rights). NULL => 0.
create function private.role_level(r public.app_role)
returns integer
language sql immutable
set search_path = ''
as $$
  select case r
    when 'manager'   then 5
    when 'officer'   then 4
    when 'cs'        then 3
    when 'trooper'   then 2
    when 'read_only' then 1
    else 0
  end
$$;

-- Letter prefix expected for an offense code of a given procedure.
create function private.procedure_prefix(p public.procedure_code)
returns text
language sql immutable
set search_path = ''
as $$
  select case p
    when 'alpha'   then 'A'
    when 'foxtrot' then 'F'
    when 'tango'   then 'T'
    when 'delta'   then 'D'
    when 'lima'    then 'L'
    when 'hotel'   then 'H'
    when 'sierra'  then 'S'
  end
$$;

-- -----------------------------------------------------------------------------
-- 3. Tables
-- -----------------------------------------------------------------------------

-- Editable list of ranks.
create table public.ranks (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 50),
  short_name  text check (short_name is null or char_length(btrim(short_name)) between 1 and 10),
  sort_order  integer not null default 0 check (sort_order between 0 and 10000),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Units a member can belong to (several at once):
--   kind = 'squad'    : a team. A CS may edit logs written by members sharing one of their squads.
--   kind = 'function' : a role such as Internal Affairs or Instructor. No extra rights (yet).
create table public.squads (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 50),
  kind        text not null default 'squad' check (kind in ('squad', 'function')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One row per auth user, created automatically on sign-up.
create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  roblox_username  text check (roblox_username is null or private.is_valid_username(roblox_username)),
  service_number   text check (service_number is null or service_number ~ '^[A-Za-z0-9-]{1,20}$'),
  rank_id          uuid references public.ranks (id) on delete set null,
  role             public.app_role not null default 'pending',
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Squad / function memberships (many-to-many). Managed by the manager.
create table public.profile_squads (
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  squad_id    uuid not null references public.squads (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (profile_id, squad_id)
);

-- Offense catalog (reference table: drop-down + calculation engine).
create table public.offenses (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null check (code ~ '^[AFTDLHS][0-9]{1,3}\.[0-9]{1,2}$'),
  code_number           numeric generated always as (substring(code from 2)::numeric) stored,
  procedure             public.procedure_code not null,
  name                  text not null check (char_length(btrim(name)) between 3 and 200),
  target                public.offense_target not null,
  jail_seconds          integer check (jail_seconds is null or jail_seconds between 1 and 86400),
  max_warnings          smallint check (max_warnings is null or max_warnings between 0 and 20),
  default_action        public.sanction_action not null,
  requires_cs_approval  boolean not null default false,
  report_required       boolean not null default false,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint offenses_code_key unique (code),
  constraint offenses_code_matches_procedure check (left(code, 1) = private.procedure_prefix(procedure))
);

-- Sanction logs.
create table public.sanction_logs (
  id                          uuid primary key default gen_random_uuid(),
  log_number                  text not null,                       -- LOG-YYYY-00001, set by trigger
  procedure                   public.procedure_code not null,      -- copied from the offense by trigger
  offense_id                  uuid not null,
  target_username             text not null check (private.is_valid_username(target_username)),
  target_normalized           text not null check (target_normalized ~ '^[a-z0-9_]{3,20}$'),
  target_type                 public.target_type not null,
  action_taken                public.sanction_action not null,
  warning_number              smallint check (warning_number is null or warning_number between 1 and 100),
  jail_seconds                integer check (jail_seconds is null or jail_seconds between 1 and 86400),

  -- What the engine recommended at write time (server-computed, never trusted from client)
  prior_warnings              smallint not null default 0 check (prior_warnings >= 0),
  recommended_action          public.sanction_action not null,
  recommendation_code         text not null check (recommendation_code in (
                                'warning', 'arrest_authorized', 'immediate_arrest', 'arrest',
                                'termination', 'relocation', 'search', 'detention',
                                'order_arrest', 'order_kill')),
  recommended_warning_number  smallint check (recommended_warning_number is null or recommended_warning_number between 1 and 100),
  is_override                 boolean not null default false,      -- action_taken <> recommended_action
  override_reason             text check (override_reason is null or char_length(override_reason) between 3 and 500),

  agent_id                    uuid not null,
  created_by                  uuid not null,
  approved_by                 uuid,                                -- CS+ who approved (required for arrest on a ⧭ offense)
  approval_confirmed_by       uuid,                                -- CS+ who confirmed the approval on the site
  approval_confirmed_at       timestamptz,
  ordered_by                  text check (ordered_by is null or char_length(btrim(ordered_by)) between 2 and 100),
  order_type                  public.order_type not null default 'none',
  report_filed                boolean not null default false,
  location                    text check (location is null or char_length(btrim(location)) between 1 and 120),
  occurred_at                 timestamptz not null default now(),
  notes                       text check (notes is null or char_length(notes) <= 4000),
  evidence_urls               text[] not null default '{}' check (private.valid_evidence_urls(evidence_urls)),
  status                      public.log_status not null default 'valid',
  void_reason                 text check (void_reason is null or char_length(btrim(void_reason)) between 3 and 500),
  voided_by                   uuid,
  voided_at                   timestamptz,
  counts_for_warnings         boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  deleted_at                  timestamptz,

  constraint sanction_logs_log_number_key unique (log_number),
  constraint sanction_logs_log_number_format check (log_number ~ '^LOG-[0-9]{4}-[0-9]{5,}$'),
  constraint sanction_logs_offense_id_fkey foreign key (offense_id) references public.offenses (id) on delete restrict,
  constraint sanction_logs_agent_id_fkey foreign key (agent_id) references public.profiles (id) on delete restrict,
  constraint sanction_logs_created_by_fkey foreign key (created_by) references public.profiles (id) on delete restrict,
  constraint sanction_logs_approved_by_fkey foreign key (approved_by) references public.profiles (id) on delete restrict,
  constraint sanction_logs_approval_confirmed_by_fkey foreign key (approval_confirmed_by) references public.profiles (id) on delete restrict,
  constraint sanction_logs_voided_by_fkey foreign key (voided_by) references public.profiles (id) on delete restrict,
  constraint sanction_logs_order_needs_issuer check (order_type = 'none' or ordered_by is not null),
  constraint sanction_logs_void_consistency check (
    (status = 'voided' and void_reason is not null and voided_at is not null)
    or (status = 'valid' and void_reason is null and voided_at is null and voided_by is null)
  ),
  constraint sanction_logs_confirmation_consistency check ((approval_confirmed_by is null) = (approval_confirmed_at is null)),
  constraint sanction_logs_warning_number_action check (warning_number is null or action_taken in ('warning', 'relocation')),
  constraint sanction_logs_jail_action check (jail_seconds is null or action_taken in ('arrest', 'detention')),
  constraint sanction_logs_override_reason check (
    not is_override or order_type <> 'none' or override_reason is not null
  )
);

-- Warning resets for a player, for one offense or all (offense_id NULL).
create table public.warning_resets (
  id                 uuid primary key default gen_random_uuid(),
  target_normalized  text not null check (target_normalized ~ '^[a-z0-9_]{3,20}$'),
  offense_id         uuid references public.offenses (id) on delete restrict,
  reset_by           uuid not null default auth.uid() references public.profiles (id) on delete restrict,
  reason             text not null check (char_length(btrim(reason)) between 3 and 500),
  logs_affected      integer not null default 0 check (logs_affected >= 0),
  created_at         timestamptz not null default now()
);

-- Player aliases: an old Roblox username pointing to the current (canonical) one.
-- Created by public.merge_players(). New logs typed with the alias are filed
-- under the canonical username automatically.
create table public.player_aliases (
  id                    uuid primary key default gen_random_uuid(),
  alias_normalized      text not null check (alias_normalized ~ '^[a-z0-9_]{3,20}$'),
  canonical_normalized  text not null check (canonical_normalized ~ '^[a-z0-9_]{3,20}$'),
  note                  text check (note is null or char_length(note) <= 500),
  created_by            uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  constraint player_aliases_alias_key unique (alias_normalized),
  constraint player_aliases_not_self check (alias_normalized <> canonical_normalized)
);

-- Append-only audit trail, filled by triggers only.
create table public.audit_log (
  id          bigint generated always as identity primary key,
  user_id     uuid,                     -- no FK on purpose: history survives account deletion
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  table_name  text not null check (char_length(table_name) <= 63),
  row_id      text,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);

-- Yearly counter for log numbers (internal, not exposed by the API).
-- Failed username sign-in attempts (rate limiting, internal).
create table private.login_attempts (
  id            bigint generated always as identity primary key,
  identifier    text not null,
  ip            text,
  attempted_at  timestamptz not null default now()
);
create index login_attempts_identifier_idx on private.login_attempts (identifier, attempted_at);
create index login_attempts_ip_idx on private.login_attempts (ip, attempted_at);

create table private.log_counters (
  year        integer primary key check (year between 2000 and 9999),
  last_value  integer not null check (last_value >= 0)
);

-- -----------------------------------------------------------------------------
-- 4. Indexes
-- -----------------------------------------------------------------------------
create unique index ranks_name_lower_key on public.ranks (lower(name));
create unique index squads_name_lower_key on public.squads (lower(name));
create unique index profiles_roblox_username_lower_key on public.profiles (lower(roblox_username)) where roblox_username is not null;
create unique index profiles_service_number_key on public.profiles (upper(service_number)) where service_number is not null;
create index profiles_role_idx on public.profiles (role);
create index profile_squads_squad_idx on public.profile_squads (squad_id);

create index offenses_procedure_idx on public.offenses (procedure, code_number);

create index sanction_logs_target_offense_idx on public.sanction_logs (target_normalized, offense_id, occurred_at) where deleted_at is null;
create index sanction_logs_target_trgm_idx on public.sanction_logs using gin (target_normalized extensions.gin_trgm_ops);
create index sanction_logs_occurred_at_idx on public.sanction_logs (occurred_at desc);
create index sanction_logs_created_at_idx on public.sanction_logs (created_at desc);
create index sanction_logs_agent_idx on public.sanction_logs (agent_id, occurred_at desc);
create index sanction_logs_offense_idx on public.sanction_logs (offense_id);
create index sanction_logs_status_idx on public.sanction_logs (status) where deleted_at is null;
create index sanction_logs_procedure_idx on public.sanction_logs (procedure);
create index sanction_logs_action_idx on public.sanction_logs (action_taken);
create index sanction_logs_pending_approval_idx on public.sanction_logs (created_at desc)
  where approved_by is not null and approval_confirmed_at is null and deleted_at is null;

create index warning_resets_target_idx on public.warning_resets (target_normalized, offense_id, created_at desc);
create index player_aliases_canonical_idx on public.player_aliases (canonical_normalized);

create index audit_log_created_at_idx on public.audit_log (created_at desc);
create index audit_log_table_row_idx on public.audit_log (table_name, row_id);
create index audit_log_user_idx on public.audit_log (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 5. Role helper functions (SECURITY DEFINER: read profiles without RLS recursion)
-- -----------------------------------------------------------------------------

-- Role of the current user, or NULL if not logged in / deactivated.
create function private.current_app_role()
returns public.app_role
language sql stable security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
    and p.active
$$;

create function private.current_level()
returns integer
language sql stable security definer
set search_path = ''
as $$
  select private.role_level(private.current_app_role())
$$;

create function private.is_reader()        returns boolean language sql stable security definer set search_path = '' as $$ select private.current_level() >= 1 $$;
create function private.is_writer()        returns boolean language sql stable security definer set search_path = '' as $$ select private.current_level() >= 2 $$;
create function private.is_cs_plus()       returns boolean language sql stable security definer set search_path = '' as $$ select private.current_level() >= 3 $$;
create function private.is_officer_plus()  returns boolean language sql stable security definer set search_path = '' as $$ select private.current_level() >= 4 $$;
create function private.is_manager()       returns boolean language sql stable security definer set search_path = '' as $$ select private.current_level() >= 5 $$;

-- True when running without an end-user JWT (SQL Editor) or with service_role.
create function private.is_system_context()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(auth.jwt() ->> 'role', 'system') in ('system', 'service_role')
$$;

-- True when p_agent shares at least one active squad (kind = 'squad') with the
-- current user. Functions (Internal Affairs, Instructor...) do not count.
create function private.same_squad(p_agent uuid)
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

-- Canonical normalized username (follows aliases).
create function private.resolve_player(p_username text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select a.canonical_normalized
       from public.player_aliases a
      where a.alias_normalized = private.normalize_username(p_username)),
    private.normalize_username(p_username)
  )
$$;

-- -----------------------------------------------------------------------------
-- 6. Business logic: warning recommendation engine
-- -----------------------------------------------------------------------------
-- Rules
--   * A log "counts as a warning" when warning_number IS NOT NULL, it is valid,
--     not deleted, and counts_for_warnings = true (false after a reset).
--   * max_warnings = 0          -> immediate arrest
--   * prior < max_warnings      -> Warning (prior + 1)/max
--   * prior >= max_warnings     -> arrest authorized (no new warning)
--     Reaching the max does NOT authorize the arrest: with 3/3 already given,
--     the NEXT breach authorizes it.
--   * max_warnings NULL         -> default action, no counter
--   * Arrest on Sight order     -> arrest; Kill on Sight order -> termination
-- -----------------------------------------------------------------------------
create function private.compute_recommendation(
  p_target_normalized text,
  p_offense_id uuid,
  p_occurred_at timestamptz,
  p_order public.order_type default 'none',
  p_exclude_log uuid default null,
  out prior_warnings integer,
  out max_warnings integer,
  out recommended_action public.sanction_action,
  out recommendation_code text,
  out recommended_warning_number integer,
  out jail_seconds integer,
  out requires_cs_approval boolean,
  out report_required boolean,
  out procedure public.procedure_code,
  out offense_target public.offense_target,
  out last_reset_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  o public.offenses%rowtype;
begin
  select * into o from public.offenses where id = p_offense_id;
  if not found then
    raise exception 'Unknown offense.' using errcode = 'P0002';
  end if;

  select count(*)::integer into prior_warnings
  from public.sanction_logs l
  where l.target_normalized = p_target_normalized
    and l.offense_id = p_offense_id
    and l.warning_number is not null
    and l.counts_for_warnings
    and l.status = 'valid'
    and l.deleted_at is null
    and l.occurred_at <= coalesce(p_occurred_at, now())
    and (p_exclude_log is null or l.id <> p_exclude_log);

  select max(r.created_at) into last_reset_at
  from public.warning_resets r
  where r.target_normalized = p_target_normalized
    and (r.offense_id is null or r.offense_id = p_offense_id);

  max_warnings          := o.max_warnings;
  requires_cs_approval  := o.requires_cs_approval;
  report_required       := o.report_required;
  procedure             := o.procedure;
  offense_target        := o.target;
  recommended_warning_number := null;

  if p_order = 'kill_on_sight' then
    recommended_action  := 'termination';
    recommendation_code := 'order_kill';
  elsif p_order = 'arrest_on_sight' then
    recommended_action  := 'arrest';
    recommendation_code := 'order_arrest';
  elsif o.default_action = 'arrest' then
    if o.max_warnings is null then
      recommended_action  := 'arrest';
      recommendation_code := 'arrest';
    elsif o.max_warnings = 0 then
      recommended_action  := 'arrest';
      recommendation_code := 'immediate_arrest';
    elsif prior_warnings < o.max_warnings then
      recommended_action  := 'warning';
      recommendation_code := 'warning';
      recommended_warning_number := prior_warnings + 1;
    else
      recommended_action  := 'arrest';
      recommendation_code := 'arrest_authorized';
    end if;
  elsif o.default_action = 'warning' then
    if o.max_warnings is not null and o.max_warnings > 0 and prior_warnings >= o.max_warnings then
      recommended_action  := 'arrest';
      recommendation_code := 'arrest_authorized';
    else
      recommended_action  := 'warning';
      recommendation_code := 'warning';
      recommended_warning_number := prior_warnings + 1;
    end if;
  elsif o.default_action = 'relocation' then
    -- Delta: cuff out + warning, counter without max unless one is defined
    recommended_action  := 'relocation';
    recommendation_code := 'relocation';
    if o.max_warnings is null or prior_warnings < o.max_warnings then
      recommended_warning_number := prior_warnings + 1;
    end if;
  else
    -- termination, search, detention
    recommended_action  := o.default_action;
    recommendation_code := o.default_action::text;
  end if;

  jail_seconds := case when recommended_action in ('arrest', 'detention') then o.jail_seconds end;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Triggers
-- -----------------------------------------------------------------------------

-- 7.1 Generic updated_at
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger ranks_set_updated_at before update on public.ranks
  for each row execute function private.set_updated_at();
create trigger squads_set_updated_at before update on public.squads
  for each row execute function private.set_updated_at();

-- 7.2 Generic audit trail
create function private.audit_row_change()
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

-- 7.3 audit_log is append-only (even for the table owner)
create function private.audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'The audit log is append-only: updates and deletions are forbidden.'
    using errcode = '42501';
end;
$$;

create trigger audit_log_no_update_delete before update or delete on public.audit_log
  for each row execute function private.audit_log_immutable();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function private.audit_log_immutable();

-- 7.4 New auth user -> pending profile
create function private.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_name text := btrim(new.raw_user_meta_data ->> 'roblox_username');
begin
  if not private.is_valid_username(v_name)
     or exists (select 1 from public.profiles p where lower(p.roblox_username) = lower(v_name)) then
    v_name := null;
  end if;

  insert into public.profiles (id, roblox_username, role, active)
  values (new.id, v_name, 'pending', true);
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- 7.5 Profiles: column guard + last-manager protection
create function private.profiles_before_update()
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
      -- Someone else's profile: officers only, and never a manager account
      -- nor the manager role (no privilege escalation).
      if not private.is_officer_plus() then
        raise exception 'You can only edit your own profile.' using errcode = '42501';
      end if;
      if old.role = 'manager' or new.role = 'manager' then
        raise exception 'Only a manager can edit a manager account or grant the manager role.'
          using errcode = '42501';
      end if;
    else
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

create trigger profiles_before_update before update on public.profiles
  for each row execute function private.profiles_before_update();

-- 7.6 Offenses: normalization
create function private.offenses_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.code := upper(btrim(new.code));
  new.name := btrim(new.name);
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger offenses_before_write before insert or update on public.offenses
  for each row execute function private.offenses_before_write();

-- 7.7 Sanction logs: permissions, normalization, numbering, recommendation, ⧭ approval
create function private.sanction_logs_before_write()
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

create trigger sanction_logs_before_write before insert or update on public.sanction_logs
  for each row execute function private.sanction_logs_before_write();

-- 7.8 Warning resets: permission, normalization, and flag the affected logs
create function private.warning_resets_before_insert()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not private.is_system_context() then
    if not private.is_officer_plus() then
      raise exception 'Only officers and the manager can reset warnings.'
        using errcode = '42501';
    end if;
    new.reset_by := auth.uid();
  end if;

  if not private.is_valid_username(btrim(new.target_normalized)) then
    raise exception 'Invalid Roblox username.' using errcode = '23514';
  end if;

  new.target_normalized := private.resolve_player(new.target_normalized);
  new.reason            := btrim(new.reason);
  new.created_at        := now();

  update public.sanction_logs l
     set counts_for_warnings = false
   where l.target_normalized = new.target_normalized
     and (new.offense_id is null or l.offense_id = new.offense_id)
     and l.counts_for_warnings
     and l.deleted_at is null;
  get diagnostics v_count = row_count;

  new.logs_affected := v_count;
  return new;
end;
$$;

create trigger warning_resets_before_insert before insert on public.warning_resets
  for each row execute function private.warning_resets_before_insert();

-- 7.9 Player aliases: normalization
create function private.player_aliases_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.alias_normalized     := private.normalize_username(new.alias_normalized);
  new.canonical_normalized := private.normalize_username(new.canonical_normalized);
  new.created_at           := now();
  return new;
end;
$$;

create trigger player_aliases_before_insert before insert on public.player_aliases
  for each row execute function private.player_aliases_before_insert();

-- 7.10 Audit triggers
create trigger audit_sanction_logs  after insert or update or delete on public.sanction_logs  for each row execute function private.audit_row_change();
create trigger audit_profiles       after insert or update or delete on public.profiles       for each row execute function private.audit_row_change();
create trigger audit_offenses       after insert or update or delete on public.offenses       for each row execute function private.audit_row_change();
create trigger audit_warning_resets after insert or update or delete on public.warning_resets for each row execute function private.audit_row_change();
create trigger audit_player_aliases after insert or update or delete on public.player_aliases for each row execute function private.audit_row_change();
create trigger audit_ranks          after insert or update or delete on public.ranks          for each row execute function private.audit_row_change();
create trigger audit_squads         after insert or update or delete on public.squads         for each row execute function private.audit_row_change();
create trigger audit_profile_squads after insert or update or delete on public.profile_squads for each row execute function private.audit_row_change();

-- -----------------------------------------------------------------------------
-- 8. Views (security_invoker: the caller's RLS applies)
-- -----------------------------------------------------------------------------

-- Logs with human-readable joins, used by the list, search and CSV export.
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

-- Players aggregate (there is no players table).
create view public.players
with (security_invoker = true)
as
select
  l.target_normalized,
  (array_agg(l.target_username order by l.occurred_at desc))[1]                as last_username,
  (array_agg(l.target_type order by l.occurred_at desc))[1]                    as last_target_type,
  count(*) filter (where l.status = 'valid')                                   as total_logs,
  count(*) filter (where l.status = 'voided')                                  as voided_logs,
  max(l.occurred_at) filter (where l.status = 'valid')                         as last_sanction_at,
  min(l.occurred_at) filter (where l.status = 'valid')                         as first_sanction_at,
  count(*) filter (where l.status = 'valid' and l.action_taken = 'warning')     as warnings,
  count(*) filter (where l.status = 'valid' and l.action_taken = 'arrest')      as arrests,
  count(*) filter (where l.status = 'valid' and l.action_taken = 'termination') as terminations,
  count(*) filter (where l.status = 'valid' and l.procedure = 'alpha')          as alpha_count,
  count(*) filter (where l.status = 'valid' and l.procedure = 'foxtrot')        as foxtrot_count,
  count(*) filter (where l.status = 'valid' and l.procedure = 'tango')          as tango_count,
  count(*) filter (where l.status = 'valid' and l.procedure = 'delta')          as delta_count,
  count(*) filter (where l.status = 'valid' and l.procedure = 'lima')           as lima_count,
  count(*) filter (where l.status = 'valid' and l.procedure = 'hotel')          as hotel_count,
  count(*) filter (where l.status = 'valid' and l.procedure = 'sierra')         as sierra_count,
  coalesce(
    (select array_agg(a.alias_normalized order by a.alias_normalized)
       from public.player_aliases a
      where a.canonical_normalized = l.target_normalized),
    '{}'::text[]
  )                                                                            as aliases
from public.sanction_logs l
where l.deleted_at is null
group by l.target_normalized;

-- Warning counters per (player, offense).
create view public.warning_counters
with (security_invoker = true)
as
select
  l.target_normalized,
  l.offense_id,
  o.code,
  o.name,
  o.procedure,
  o.max_warnings,
  o.requires_cs_approval,
  count(*) filter (where l.warning_number is not null and l.counts_for_warnings)     as warnings_given,
  count(*) filter (where l.warning_number is not null and not l.counts_for_warnings) as warnings_reset,
  max(l.occurred_at)                                                                as last_occurred_at,
  case
    when o.max_warnings is null then null
    when o.max_warnings = 0 then true
    else count(*) filter (where l.warning_number is not null and l.counts_for_warnings) >= o.max_warnings
  end                                                                               as arrest_authorized
from public.sanction_logs l
join public.offenses o on o.id = l.offense_id
where l.deleted_at is null
  and l.status = 'valid'
group by l.target_normalized, l.offense_id, o.id;

-- -----------------------------------------------------------------------------
-- 9. RPC functions
-- -----------------------------------------------------------------------------

-- Live recommendation for the "new log" form.
create function public.get_recommendation(
  p_target_username text,
  p_offense_id uuid,
  p_order_type public.order_type default 'none',
  p_occurred_at timestamptz default null,
  p_exclude_log uuid default null           -- the log being edited, so it does not count itself
)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_target text;
  r record;
begin
  if not private.is_writer() then
    raise exception 'Access denied.' using errcode = '42501';
  end if;
  if not private.is_valid_username(btrim(p_target_username)) then
    raise exception 'Invalid Roblox username.' using errcode = '22023';
  end if;

  v_target := private.resolve_player(p_target_username);

  select * into r
  from private.compute_recommendation(v_target, p_offense_id, coalesce(p_occurred_at, now()), coalesce(p_order_type, 'none'), p_exclude_log);

  return jsonb_build_object(
    'target_normalized',          v_target,
    'is_alias',                   v_target <> private.normalize_username(p_target_username),
    'prior_warnings',             r.prior_warnings,
    'max_warnings',               r.max_warnings,
    'recommended_action',         r.recommended_action,
    'recommendation_code',        r.recommendation_code,
    'recommended_warning_number', r.recommended_warning_number,
    'jail_seconds',               r.jail_seconds,
    'requires_cs_approval',       r.requires_cs_approval,
    'report_required',            r.report_required,
    'procedure',                  r.procedure,
    'offense_target',             r.offense_target,
    'last_reset_at',              r.last_reset_at
  );
end;
$$;

-- CS+ confirms the ⧭ approval of a log (any squad).
create function public.confirm_approval(p_log_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_log public.sanction_logs%rowtype;
begin
  if not private.is_cs_plus() then
    raise exception 'Only a CS, an officer or the manager can confirm an approval.' using errcode = '42501';
  end if;

  select * into v_log from public.sanction_logs where id = p_log_id and deleted_at is null;
  if not found then
    raise exception 'Log not found.' using errcode = 'P0002';
  end if;
  if v_log.approved_by is null then
    raise exception 'This log has no approver to confirm.' using errcode = '22023';
  end if;
  if v_log.approval_confirmed_at is not null then
    raise exception 'This approval is already confirmed.' using errcode = '22023';
  end if;

  update public.sanction_logs
     set approval_confirmed_by = auth.uid()
   where id = p_log_id;
end;
$$;

-- Manager: merge a player record into another (old username -> current username).
create function public.merge_players(p_from text, p_into text, p_note text default null)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_from  text;
  v_into  text;
  v_count integer;
begin
  if not private.is_manager() then
    raise exception 'Only the manager can merge usernames.' using errcode = '42501';
  end if;
  if not private.is_valid_username(btrim(p_from)) or not private.is_valid_username(btrim(p_into)) then
    raise exception 'Invalid Roblox username.' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    raise exception 'Note too long (500 characters max).' using errcode = '22023';
  end if;

  v_from := private.resolve_player(p_from);
  v_into := private.resolve_player(p_into);
  if v_from = v_into then
    raise exception 'These two usernames already refer to the same player.' using errcode = '22023';
  end if;

  insert into public.player_aliases (alias_normalized, canonical_normalized, note, created_by)
  values (v_from, v_into, nullif(btrim(p_note), ''), auth.uid());

  update public.player_aliases set canonical_normalized = v_into where canonical_normalized = v_from;
  update public.warning_resets set target_normalized = v_into where target_normalized = v_from;
  update public.sanction_logs  set target_normalized = v_into where target_normalized = v_from;
  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

-- Manager: undo an alias. Logs typed with exactly that username go back to it.
create function public.unmerge_player(p_alias text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_alias text := private.normalize_username(p_alias);
  v_canon text;
  v_count integer;
begin
  if not private.is_manager() then
    raise exception 'Only the manager can undo a merge.' using errcode = '42501';
  end if;

  delete from public.player_aliases
   where alias_normalized = v_alias
  returning canonical_normalized into v_canon;
  if v_canon is null then
    raise exception 'Alias not found.' using errcode = 'P0002';
  end if;

  update public.sanction_logs
     set target_normalized = v_alias
   where target_normalized = v_canon
     and lower(target_username) = v_alias;
  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

-- Manager: update a member profile and their squad / function memberships in
-- ONE transaction (all or nothing). SECURITY INVOKER: RLS and the profile
-- triggers apply exactly as for direct updates.
create function public.update_member(
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
  if not private.is_officer_plus() then
    raise exception 'Only an officer or the manager can edit members.' using errcode = '42501';
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

-- Modification history of one log (from audit_log), for any reader of that log.
create function public.get_log_history(p_log_id uuid)
returns table (
  id               bigint,
  user_id          uuid,
  user_username    text,
  action           text,
  old_data         jsonb,
  new_data         jsonb,
  created_at       timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_reader() then
    raise exception 'Access denied.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.sanction_logs l
    where l.id = p_log_id and (l.deleted_at is null or private.is_manager())
  ) then
    raise exception 'Log not found.' using errcode = 'P0002';
  end if;

  return query
  select a.id, a.user_id, p.roblox_username, a.action, a.old_data, a.new_data, a.created_at
  from public.audit_log a
  left join public.profiles p on p.id = a.user_id
  where a.table_name = 'sanction_logs'
    and a.row_id = p_log_id::text
  order by a.created_at, a.id;
end;
$$;

-- Dashboard figures in one round trip. p_tz = IANA time zone of the browser.
create function public.dashboard_stats(p_tz text default 'UTC')
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

-- Sign-in with a Roblox username (Supabase Auth only accepts an email).
-- Returns the account email ONLY when the password is correct, so emails
-- cannot be harvested from usernames. The password is checked against the
-- bcrypt hash stored by Supabase Auth. The front then signs in normally
-- with that email.
-- Brute-force protection (this path bypasses Supabase Auth rate limits):
--   5 failures per username or 20 failures per IP within 15 minutes -> locked.
-- Returns {"email": "..."} on success, {"email": null} on failure,
-- {"locked": true} when rate-limited. Never raises on a wrong password, so
-- the failure row is kept.
create function public.resolve_login_email(p_identifier text, p_password text)
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

-- -----------------------------------------------------------------------------
-- 10. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.ranks           enable row level security;
alter table public.squads          enable row level security;
alter table public.profile_squads  enable row level security;
alter table public.profiles        enable row level security;
alter table public.offenses        enable row level security;
alter table public.sanction_logs   enable row level security;
alter table public.warning_resets  enable row level security;
alter table public.player_aliases  enable row level security;
alter table public.audit_log       enable row level security;
alter table private.log_counters   enable row level security;
alter table private.login_attempts enable row level security;

-- ranks
create policy ranks_select on public.ranks for select to authenticated
  using ((select private.is_reader()));
create policy ranks_insert on public.ranks for insert to authenticated
  with check ((select private.is_officer_plus()));
create policy ranks_update on public.ranks for update to authenticated
  using ((select private.is_officer_plus())) with check ((select private.is_officer_plus()));
create policy ranks_delete on public.ranks for delete to authenticated
  using ((select private.is_officer_plus()));

-- squads
create policy squads_select on public.squads for select to authenticated
  using ((select private.is_reader()));
create policy squads_insert on public.squads for insert to authenticated
  with check ((select private.is_officer_plus()));
create policy squads_update on public.squads for update to authenticated
  using ((select private.is_officer_plus())) with check ((select private.is_officer_plus()));
create policy squads_delete on public.squads for delete to authenticated
  using ((select private.is_officer_plus()));

-- profile_squads (memberships, managed by the manager)
create policy profile_squads_select on public.profile_squads for select to authenticated
  using ((select private.is_reader()) or profile_id = (select auth.uid()));
create policy profile_squads_insert on public.profile_squads for insert to authenticated
  with check ((select private.is_officer_plus()));
create policy profile_squads_delete on public.profile_squads for delete to authenticated
  using ((select private.is_officer_plus()));

-- profiles (insert by trigger only; deletion through Supabase Auth only)
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_reader()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()) or (select private.is_officer_plus()))
  with check (id = (select auth.uid()) or (select private.is_officer_plus()));

-- offenses
create policy offenses_select on public.offenses for select to authenticated
  using ((select private.is_reader()));
create policy offenses_insert on public.offenses for insert to authenticated
  with check ((select private.is_manager()));
create policy offenses_update on public.offenses for update to authenticated
  using ((select private.is_manager())) with check ((select private.is_manager()));
create policy offenses_delete on public.offenses for delete to authenticated
  using ((select private.is_manager()));

-- sanction_logs
create policy sanction_logs_select on public.sanction_logs for select to authenticated
  using (
    (select private.is_reader())
    and (deleted_at is null or (select private.is_manager()))
  );

create policy sanction_logs_insert on public.sanction_logs for insert to authenticated
  with check (
    (select private.is_writer())
    and (agent_id = (select auth.uid()) or (select private.is_officer_plus()))
  );

create policy sanction_logs_update on public.sanction_logs for update to authenticated
  using (
    (deleted_at is null or (select private.is_manager()))
    and (
      (select private.is_officer_plus())
      or ((select private.current_app_role()) = 'cs'
          and (agent_id = (select auth.uid()) or private.same_squad(agent_id)))
      or ((select private.current_app_role()) = 'trooper'
          and agent_id = (select auth.uid())
          and created_at > now() - interval '24 hours')
    )
  )
  with check ((select private.is_writer()));

create policy sanction_logs_delete on public.sanction_logs for delete to authenticated
  using ((select private.is_manager()));

-- warning_resets (append-only)
create policy warning_resets_select on public.warning_resets for select to authenticated
  using ((select private.is_reader()));
create policy warning_resets_insert on public.warning_resets for insert to authenticated
  with check ((select private.is_officer_plus()));

-- player_aliases (written through merge_players / unmerge_player)
create policy player_aliases_select on public.player_aliases for select to authenticated
  using ((select private.is_reader()));
create policy player_aliases_insert on public.player_aliases for insert to authenticated
  with check ((select private.is_manager()));
create policy player_aliases_delete on public.player_aliases for delete to authenticated
  using ((select private.is_manager()));

-- audit_log (manager read-only; rows come from triggers)
create policy audit_log_select on public.audit_log for select to authenticated
  using ((select private.is_manager()));

-- log_counters: never accessible to clients
create policy log_counters_no_client_access on private.log_counters for all to authenticated
  using (false) with check (false);
create policy login_attempts_no_client_access on private.login_attempts for all to authenticated
  using (false) with check (false);

-- -----------------------------------------------------------------------------
-- 11. Grants
-- -----------------------------------------------------------------------------
-- Anonymous visitors get nothing.
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon, public;

-- Authenticated users: table access is then filtered by RLS.
grant select, insert, update, delete on public.ranks, public.squads, public.offenses, public.sanction_logs to authenticated;
grant select, insert, delete on public.profile_squads to authenticated;
revoke update on public.profile_squads from authenticated;
grant select, update on public.profiles to authenticated;
revoke insert, delete on public.profiles from authenticated;
grant select, insert on public.warning_resets to authenticated;
revoke update, delete on public.warning_resets from authenticated;
grant select, insert, delete on public.player_aliases to authenticated;
revoke update on public.player_aliases from authenticated;
grant select on public.audit_log to authenticated;
revoke insert, update, delete, truncate on public.audit_log from authenticated;
grant select on public.sanction_logs_expanded, public.players, public.warning_counters to authenticated;

grant execute on function public.get_recommendation(text, uuid, public.order_type, timestamptz, uuid) to authenticated;
grant execute on function public.confirm_approval(uuid)                                         to authenticated;
grant execute on function public.merge_players(text, text, text)                                to authenticated;
grant execute on function public.unmerge_player(text)                                           to authenticated;
grant execute on function public.update_member(uuid, text, text, public.app_role, uuid, boolean, uuid[]) to authenticated;
grant execute on function public.get_log_history(uuid)                                          to authenticated;
grant execute on function public.dashboard_stats(text)                                          to authenticated;
-- Sign-in page: callable before authentication
grant execute on function public.resolve_login_email(text, text)                               to anon, authenticated;

-- Private schema: only what RLS policies need at evaluation time.
revoke all on all tables    in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.current_app_role()  to authenticated;
grant execute on function private.current_level()     to authenticated;
grant execute on function private.role_level(public.app_role) to authenticated;
grant execute on function private.is_reader()         to authenticated;
grant execute on function private.is_writer()         to authenticated;
grant execute on function private.is_cs_plus()        to authenticated;
grant execute on function private.is_officer_plus()   to authenticated;
grant execute on function private.is_manager()        to authenticated;
grant execute on function private.same_squad(uuid)    to authenticated;
grant execute on function private.is_valid_username(text)      to authenticated;
grant execute on function private.normalize_username(text)     to authenticated;
grant execute on function private.valid_evidence_urls(text[])  to authenticated;
grant execute on function private.procedure_prefix(public.procedure_code) to authenticated;

-- -----------------------------------------------------------------------------
-- 12. Seed data
-- -----------------------------------------------------------------------------
insert into public.ranks (name, short_name, sort_order) values
  ('Shock Trooper',     'ST',  10),
  ('Company Sergeant',  'CS',  20),
  ('Lieutenant',        'LT',  30),
  ('Captain',           'CPT', 40);

-- Example functions (rename / add more from the Members > Squads & functions page).
insert into public.squads (name, kind) values
  ('Internal Affairs', 'function'),
  ('Instructor',       'function');

-- Offense catalog - normalized codes from the public CST Cuff Guide.
insert into public.offenses
  (code, procedure, name, target, jail_seconds, max_warnings, default_action, requires_cs_approval, report_required)
values
  -- Alpha: cuff & jail imperial personnel
  ('A1.0',  'alpha', 'Arrest on Sight Order',                                         'personnel', 300, 0, 'arrest', false, false),
  ('A2.0',  'alpha', 'Successful Team kill',                                          'personnel', 300, 0, 'arrest', false, false),
  ('A3.0',  'alpha', 'Successful Random kill',                                        'personnel', 300, 0, 'arrest', false, false),
  ('A4.0',  'alpha', 'Attempted TK of a Divisional',                                  'personnel', 300, 1, 'arrest', false, false),
  ('A5.0',  'alpha', 'Trespassing',                                                   'personnel', 120, 3, 'arrest', false, false),
  ('A6.0',  'alpha', 'Post refusal',                                                  'personnel', 120, 3, 'arrest', false, false),
  ('A7.0',  'alpha', 'Disrupting divisional duties',                                  'personnel', 120, 2, 'arrest', false, false),
  ('A8.0',  'alpha', 'Being terminated for entering a VIP''s killzone 3 times',       'personnel', 120, 3, 'arrest', false, false),
  ('A9.0',  'alpha', 'Interfering with the beginning or ending phase of an event',    'personnel', 300, 0, 'arrest', false, false),
  ('A10.0', 'alpha', 'Toxicity / Trolling',                                           'personnel', 300, 3, 'arrest', true,  false),
  ('A11.0', 'alpha', 'Refusing to comply with lawful orders',                         'personnel', 120, 3, 'arrest', true,  false),
  ('A12.0', 'alpha', 'Sexual Gestures (Robanging, etc.)',                             'personnel', 300, 0, 'arrest', true,  true),
  ('A13.0', 'alpha', 'AFK farming',                                                   'personnel', 300, 3, 'arrest', true,  true),
  ('A14.0', 'alpha', 'Bug abuse',                                                     'personnel', 300, 0, 'arrest', true,  true),
  -- Foxtrot: cuff & jail immigrants
  ('F1.0',  'foxtrot', 'Arrest on Sight Order',                                       'immigrant', 300, 0, 'arrest', false, false),
  ('F2.0',  'foxtrot', 'Spawnkilling',                                                'immigrant', 300, 0, 'arrest', false, false),
  ('F3.0',  'foxtrot', 'Interfering with the beginning or ending phase of an event',  'immigrant', 300, 0, 'arrest', false, false),
  ('F4.0',  'foxtrot', 'Toxicity / Trolling',                                         'immigrant', 300, 3, 'arrest', true,  false),
  ('F5.0',  'foxtrot', 'Sexual Gestures (Robanging, etc.)',                           'immigrant', 300, 0, 'arrest', true,  true),
  ('F6.0',  'foxtrot', 'Bug abuse',                                                   'immigrant', 300, 0, 'arrest', true,  true),
  -- Tango: immediate termination
  ('T1.0',  'tango', 'Kill on Sight Order',                                           'both',      null, 0, 'termination', false, false),
  ('T2.0',  'tango', 'Off-duty morph openly carries weapon',                          'personnel', null, 0, 'termination', false, false),
  ('T3.0',  'tango', 'Chat bypassing',                                                'both',      null, 0, 'termination', false, true),
  ('T4.0',  'tango', 'Immigrant walks out of the dedicated pathway in the border',    'immigrant', null, 0, 'termination', false, false),
  ('T5.0',  'tango', 'Immigrant enters a booth',                                      'immigrant', null, 0, 'termination', false, false),
  -- Delta: cuff & relocate (cuff out) + warning, no max defined
  ('D1.0',  'delta', 'Imperial personnel enters a restricted area',                   'personnel', null, null, 'relocation', false, false),
  -- Sierra: cuff, jail or terminate Divisional personnel (stricter than Alpha)
  ('S1.0',  'sierra', 'Arrest on Sight Order',                                        'personnel', 300, 0, 'arrest', false, false),
  ('S2.0',  'sierra', 'On duty Raiding',                                              'personnel', 300, 0, 'arrest', false, false),
  ('S3.0',  'sierra', 'Multiple Successful Random Kills',                             'personnel', 300, 0, 'arrest', false, false),
  ('S4.0',  'sierra', 'Massively disturbing an Official event hosting',               'personnel', 300, 0, 'arrest', false, false),
  ('S5.0',  'sierra', 'Interfering with an arrest, cuffing or lawful action of a Shock Trooper', 'personnel', 300, 0, 'arrest', false, false),
  ('S6.0',  'sierra', 'Abusing Divisional weapons, tools or privileges',              'personnel', 300, 0, 'arrest', false, false),
  ('S7.0',  'sierra', 'Trespassing in an area beyond Divisional clearance',           'personnel', 120, 1, 'arrest', false, false),
  ('S8.0',  'sierra', 'Disrupting divisional duties',                                 'personnel', 120, 1, 'arrest', false, false),
  ('S9.0',  'sierra', 'Failing to STS during events (verbal warnings, then cuff to pads)', 'personnel', null, 2, 'arrest', false, false),
  ('S10.0', 'sierra', 'Kill on Sight Order',                                          'personnel', null, 0, 'termination', false, false),
  ('S11.0', 'sierra', 'Attacking or attempting to kill an Officer+ without a valid order (termination and arrest)', 'personnel', null, 0, 'termination', false, false),
  ('S12.0', 'sierra', 'Being terminated for entering an ERG, CST or IDT VIP''s killzone 2 times', 'personnel', 120, 2, 'arrest', false, false);
  -- Lima (search) and Hotel (detention): no offenses defined yet (TBD in the guide).
  -- The manager adds them from the "Offense catalog" page.

commit;

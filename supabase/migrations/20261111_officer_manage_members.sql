-- =============================================================================
-- Migration 2026-11-11: officers can manage members, ranks and squads
--
-- Before: manager only. Now: officer and manager.
-- Guardrails for officers (enforced by the profiles trigger, not just the UI):
--   * cannot edit a manager account
--   * cannot grant the manager role
--   * cannot change their own role, status, rank or service number
-- Only the manager keeps: offense catalog, audit log, username merges,
-- deleting logs.
--
-- Run ONCE in the Supabase SQL Editor, after 20261110_sierra_offenses.sql.
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

drop policy ranks_insert on public.ranks;
drop policy ranks_update on public.ranks;
drop policy ranks_delete on public.ranks;
drop policy squads_insert on public.squads;
drop policy squads_update on public.squads;
drop policy squads_delete on public.squads;
drop policy profile_squads_insert on public.profile_squads;
drop policy profile_squads_delete on public.profile_squads;
drop policy profiles_update on public.profiles;

create policy ranks_insert on public.ranks for insert to authenticated
  with check ((select private.is_officer_plus()));
create policy ranks_update on public.ranks for update to authenticated
  using ((select private.is_officer_plus())) with check ((select private.is_officer_plus()));
create policy ranks_delete on public.ranks for delete to authenticated
  using ((select private.is_officer_plus()));
create policy squads_insert on public.squads for insert to authenticated
  with check ((select private.is_officer_plus()));
create policy squads_update on public.squads for update to authenticated
  using ((select private.is_officer_plus())) with check ((select private.is_officer_plus()));
create policy squads_delete on public.squads for delete to authenticated
  using ((select private.is_officer_plus()));
create policy profile_squads_insert on public.profile_squads for insert to authenticated
  with check ((select private.is_officer_plus()));
create policy profile_squads_delete on public.profile_squads for delete to authenticated
  using ((select private.is_officer_plus()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()) or (select private.is_officer_plus()))
  with check (id = (select auth.uid()) or (select private.is_officer_plus()));

commit;

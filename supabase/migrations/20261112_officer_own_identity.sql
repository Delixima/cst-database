-- =============================================================================
-- Migration 2026-11-12: officers can change their own service number and username
--
-- Role, status and rank still cannot be changed by oneself (manager only).
-- Other members keep the previous rules.
--
-- Run ONCE in the Supabase SQL Editor, after 20261111_officer_manage_members.sql.
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
      -- Own profile: nobody but the manager changes their own role, status or rank.
      if (new.role, new.active, new.rank_id)
         is distinct from (old.role, old.active, old.rank_id) then
        raise exception 'Only the manager can change the role, status or rank.'
          using errcode = '42501';
      end if;
      -- Service number and username: officers may change their own; other members
      -- cannot (username only while pending, as a sign-up fix-up).
      if not private.is_officer_plus() then
        if new.service_number is distinct from old.service_number then
          raise exception 'Only the manager can change the service number.'
            using errcode = '42501';
        end if;
        if new.roblox_username is distinct from old.roblox_username and old.role <> 'pending' then
          raise exception 'Your Roblox username can only be changed by the manager once your account is approved.'
            using errcode = '42501';
        end if;
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

commit;

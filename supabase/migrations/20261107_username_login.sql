-- =============================================================================
-- Migration 2026-11-07: sign in with a Roblox username or an email
--
-- Adds public.resolve_login_email(identifier, password): returns the account
-- email only when the password is correct (bcrypt check against Supabase Auth),
-- with rate limiting (5 failures per username / 20 per IP in 15 minutes).
--
-- Run ONCE in the Supabase SQL Editor, after 20261106_multi_squads.sql.
-- A fresh install does not need this file: schema.sql already contains it.
-- =============================================================================

begin;

create extension if not exists pgcrypto with schema extensions;

create table private.login_attempts (
  id            bigint generated always as identity primary key,
  identifier    text not null,
  ip            text,
  attempted_at  timestamptz not null default now()
);
create index login_attempts_identifier_idx on private.login_attempts (identifier, attempted_at);
create index login_attempts_ip_idx on private.login_attempts (ip, attempted_at);

alter table private.login_attempts enable row level security;
create policy login_attempts_no_client_access on private.login_attempts for all to authenticated
  using (false) with check (false);
revoke all on private.login_attempts from public, anon, authenticated;

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

  begin
    v_ip := nullif(btrim(split_part(
      coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)), '');
  exception when others then
    v_ip := null;
  end;

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

revoke all on function public.resolve_login_email(text, text) from public;
grant execute on function public.resolve_login_email(text, text) to anon, authenticated;

commit;

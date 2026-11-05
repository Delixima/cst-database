-- =============================================================================
-- CST Sanction Logs - RLS & trigger verification
--
-- Run in the Supabase SQL Editor AFTER schema.sql (or with psql as postgres).
--
-- How it works
--   * Everything runs in ONE transaction. Test users, logs, resets... are
--     created, checked role by role, then thrown away.
--   * The script ALWAYS ends with an intentional error. That error is what
--     rolls everything back, and its message is the test report:
--         ALL TESTS PASSED (n/n) ...        -> everything is fine
--         TESTS FAILED (x/n): label: detail -> something is wrong
--   * Nothing is kept in your database, except that the yearly log counter
--     is rolled back too (numbers stay continuous).
--
-- Roles are simulated like PostgREST does it: SET ROLE authenticated +
-- request.jwt.claims containing the user id.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Test harness
-- -----------------------------------------------------------------------------
create schema tests;
create table tests.results (id serial primary key, ok boolean not null, label text not null, detail text);
create table tests.ids (name text primary key, id uuid not null);
grant usage on schema tests to authenticated, anon;
grant all on all tables in schema tests to authenticated, anon;
grant all on all sequences in schema tests to authenticated, anon;

create function tests.ok(p_ok boolean, p_label text, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into tests.results (ok, label, detail) values (coalesce(p_ok, false), p_label, p_detail);
end $$;

-- Expects p_sql to fail with an error message matching p_pattern (case-insensitive regex).
create function tests.throws(p_sql text, p_pattern text, p_label text)
returns void language plpgsql as $$
begin
  execute p_sql;
  perform tests.ok(false, p_label, 'no error raised');
exception when others then
  perform tests.ok(sqlerrm ~* p_pattern, p_label, sqlerrm);
end $$;

-- Number of rows returned by a SELECT.
create function tests.count_rows(p_sql text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from (%s) s', p_sql) into n;
  return n;
end $$;

-- Number of rows affected by an UPDATE/DELETE (0 = silently filtered by RLS).
create function tests.affected(p_sql text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('with x as (%s returning 1) select count(*) from x', p_sql) into n;
  return n;
end $$;

create function tests.id(p_name text) returns uuid language sql stable as $$
  select id from tests.ids where name = p_name
$$;

create function tests.offense(p_code text) returns uuid language sql stable as $$
  select id from public.offenses where code = p_code
$$;

create function tests.login(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

grant execute on all functions in schema tests to authenticated, anon;

-- -----------------------------------------------------------------------------
-- Fixtures (system context)
-- -----------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'test-manager@cst.test',  '{"roblox_username":"Test_Manager"}'),
  ('00000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'test-officer@cst.test',  '{"roblox_username":"Test_Officer"}'),
  ('00000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'test-cs-a@cst.test',     '{"roblox_username":"Test_CS_A"}'),
  ('00000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'test-cs-b@cst.test',     '{"roblox_username":"Test_CS_B"}'),
  ('00000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'test-trooper-a@cst.test','{"roblox_username":"Test_Trooper_A"}'),
  ('00000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'test-trooper-b@cst.test','{"roblox_username":"Test_Trooper_B"}'),
  ('00000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', 'test-reader@cst.test',   '{"roblox_username":"Test_Reader"}'),
  ('00000000-0000-4000-8000-000000000008', 'authenticated', 'authenticated', 'test-pending@cst.test',  '{"roblox_username":"Test_Pending"}'),
  ('00000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'test-inactive@cst.test', '{"roblox_username":"Test_Inactive"}');

insert into tests.ids (name, id) values
  ('manager',   '00000000-0000-4000-8000-000000000001'),
  ('officer',   '00000000-0000-4000-8000-000000000002'),
  ('cs_a',      '00000000-0000-4000-8000-000000000003'),
  ('cs_b',      '00000000-0000-4000-8000-000000000004'),
  ('trooper_a', '00000000-0000-4000-8000-000000000005'),
  ('trooper_b', '00000000-0000-4000-8000-000000000006'),
  ('reader',    '00000000-0000-4000-8000-000000000007'),
  ('pending',   '00000000-0000-4000-8000-000000000008'),
  ('inactive',  '00000000-0000-4000-8000-000000000009');

do $$
declare v_squad_a uuid; v_squad_b uuid; v_squad_c uuid; v_function uuid;
begin
  perform tests.ok((select count(*) from public.profiles p join tests.ids i on i.id = p.id where p.role = 'pending') = 9,
    'setup: new accounts are created as pending');

  insert into public.squads (name) values ('Test Squad A') returning id into v_squad_a;
  insert into public.squads (name) values ('Test Squad B') returning id into v_squad_b;
  insert into public.squads (name) values ('Test Squad C') returning id into v_squad_c;
  insert into public.squads (name, kind) values ('Test Function', 'function') returning id into v_function;
  insert into tests.ids values ('squad_a', v_squad_a), ('squad_b', v_squad_b), ('squad_c', v_squad_c), ('function', v_function);

  update public.profiles set role = 'manager'                        where id = tests.id('manager');
  update public.profiles set role = 'officer'                        where id = tests.id('officer');
  update public.profiles set role = 'cs'      where id in (tests.id('cs_a'), tests.id('cs_b'));
  update public.profiles set role = 'trooper' where id in (tests.id('trooper_a'), tests.id('trooper_b'));
  -- cs_a: squad A + function | cs_b: squads B and C | trooper_a: squads A and C | trooper_b: squad B + function
  insert into public.profile_squads (profile_id, squad_id) values
    (tests.id('cs_a'), v_squad_a), (tests.id('cs_a'), v_function),
    (tests.id('cs_b'), v_squad_b), (tests.id('cs_b'), v_squad_c),
    (tests.id('trooper_a'), v_squad_a), (tests.id('trooper_a'), v_squad_c),
    (tests.id('trooper_b'), v_squad_b), (tests.id('trooper_b'), v_function);
  update public.profiles set role = 'read_only'                      where id = tests.id('reader');
  update public.profiles set role = 'trooper', active = false        where id = tests.id('inactive');
end $$;

-- -----------------------------------------------------------------------------
-- anon: no access at all
-- -----------------------------------------------------------------------------
set local role anon;
do $$ begin
  perform tests.throws('select * from public.sanction_logs', 'permission denied', 'anon: cannot read sanction_logs');
  perform tests.throws('select * from public.offenses', 'permission denied', 'anon: cannot read offenses');
  perform tests.throws('select * from public.profiles', 'permission denied', 'anon: cannot read profiles');
  perform tests.throws('select public.dashboard_stats()', 'permission denied', 'anon: cannot call dashboard_stats');
end $$;
reset role;

-- -----------------------------------------------------------------------------
-- pending & deactivated: see nothing but their own profile
-- -----------------------------------------------------------------------------
select tests.login(tests.id('pending'));
do $$ begin
  perform tests.ok(tests.count_rows('select 1 from public.offenses') = 0, 'pending: sees no offenses');
  perform tests.ok(tests.count_rows('select 1 from public.sanction_logs') = 0, 'pending: sees no logs');
  perform tests.ok(tests.count_rows('select 1 from public.profiles') = 1, 'pending: sees only own profile');
  perform tests.ok(tests.count_rows('select 1 from public.ranks') = 0, 'pending: sees no ranks');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('A5.0'), 'Someone_1', 'personnel', 'warning')$q$, 'row-level security|role', 'pending: cannot create a log');
  perform tests.throws($q$select public.get_recommendation('Someone_1', tests.offense('A5.0'))$q$, 'Access denied', 'pending: cannot get recommendations');
  perform tests.throws('select public.dashboard_stats()', 'Access denied', 'pending: cannot read dashboard');
  perform tests.throws($q$update public.profiles set role = 'trooper' where id = tests.id('pending')$q$, 'manager', 'pending: cannot validate itself');
  perform tests.ok(tests.affected($q$update public.profiles set roblox_username = 'Test_Pending_2' where id = tests.id('pending')$q$) = 1,
    'pending: can fix own Roblox username');
end $$;
reset role;

select tests.login(tests.id('inactive'));
do $$ begin
  perform tests.ok(tests.count_rows('select 1 from public.sanction_logs') = 0, 'inactive: sees no logs');
  perform tests.ok(tests.count_rows('select 1 from public.offenses') = 0, 'inactive: sees no offenses');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('A5.0'), 'Someone_1', 'personnel', 'warning')$q$, 'row-level security|role', 'inactive: cannot create a log');
end $$;
reset role;

-- -----------------------------------------------------------------------------
-- trooper: create logs, warning engine, own recent logs only
-- -----------------------------------------------------------------------------
select tests.login(tests.id('trooper_a'));
do $$
declare
  v_id uuid; r jsonb; l public.sanction_logs%rowtype; i integer;
begin
  perform tests.ok(tests.count_rows('select 1 from public.offenses') >= 26, 'trooper: reads the offense catalog');

  -- Warning engine on A5.0 Trespassing (max 3)
  for i in 1..3 loop
    r := public.get_recommendation('Bad_Guy_1', tests.offense('A5.0'));
    perform tests.ok(r ->> 'recommendation_code' = 'warning' and (r ->> 'recommended_warning_number')::int = i,
      format('engine: recommendation is Warning %s/3', i), r::text);
    insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('A5.0'), 'Bad_Guy_1', 'personnel', 'warning') returning * into l;
    perform tests.ok(l.warning_number = i and not l.is_override and l.log_number ~ '^LOG-[0-9]{4}-[0-9]{5}$',
      format('engine: log %s stored as Warning %s', l.log_number, i));
  end loop;

  r := public.get_recommendation('BAD_GUY_1', tests.offense('A5.0'));
  perform tests.ok(r ->> 'recommendation_code' = 'arrest_authorized' and (r ->> 'prior_warnings')::int = 3 and (r ->> 'jail_seconds')::int = 120,
    'engine: 3/3 given -> arrest authorized (120 s), case-insensitive', r::text);

  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
  values (tests.offense('A5.0'), 'Bad_Guy_1', 'personnel', 'arrest') returning * into l;
  perform tests.ok(l.jail_seconds = 120 and l.warning_number is null and not l.is_override, 'engine: arrest stored with default jail');
  insert into tests.ids values ('log_trooper_a_arrest', l.id);

  -- Immediate arrest (max 0)
  r := public.get_recommendation('Bad_Guy_2', tests.offense('A2.0'));
  perform tests.ok(r ->> 'recommendation_code' = 'immediate_arrest', 'engine: A2.0 -> immediate arrest', r::text);

  -- Override needs a reason, is recorded
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('A6.0'), 'Bad_Guy_3', 'personnel', 'arrest')$q$, 'justification', 'override: reason required');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, override_reason)
  values (tests.offense('A6.0'), 'Bad_Guy_3', 'personnel', 'arrest', 'Repeated refusal in front of witnesses') returning * into l;
  perform tests.ok(l.is_override and l.recommended_action = 'warning', 'override: recorded with the recommendation');

  -- Target type is forced by the offense
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
  values (tests.offense('F2.0'), 'Immi_1', 'personnel', 'arrest') returning * into l;
  perform tests.ok(l.target_type = 'immigrant' and l.procedure = 'foxtrot', 'consistency: Foxtrot forces immigrant target and procedure');

  -- ⧭ approval
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('A12.0'), 'Bad_Guy_4', 'personnel', 'arrest')$q$, 'approval', '⧭: arrest without approver refused');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, approved_by)
    values (tests.offense('A12.0'), 'Bad_Guy_4', 'personnel', 'arrest', tests.id('trooper_b'))$q$, 'approver', '⧭: a trooper cannot approve');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, approved_by, report_filed)
  values (tests.offense('A12.0'), 'Bad_Guy_4', 'personnel', 'arrest', tests.id('cs_b'), false) returning * into l;
  perform tests.ok(l.approval_confirmed_at is null, '⧭: arrest approved by a CS, awaiting confirmation');
  insert into tests.ids values ('log_pending_approval', l.id);
  perform tests.throws(format('select public.confirm_approval(%L)', l.id), 'CS', '⧭: trooper cannot confirm an approval');

  -- Orders
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, order_type)
    values (tests.offense('T1.0'), 'Kos_1', 'immigrant', 'termination', 'kill_on_sight')$q$, 'order', 'order: issuer required');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, order_type, ordered_by)
  values (tests.offense('T1.0'), 'Kos_1', 'immigrant', 'termination', 'kill_on_sight', 'HICOM') returning * into l;
  perform tests.ok(l.recommendation_code = 'order_kill' and not l.is_override, 'order: KOS termination');

  -- Delta relocation counts as warning without max
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
  values (tests.offense('D1.0'), 'Lost_1', 'personnel', 'relocation') returning * into l;
  perform tests.ok(l.warning_number = 1, 'Delta: cuff out + Warning 1 (no max)');

  -- Validation
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, evidence_urls)
    values (tests.offense('D1.0'), 'Lost_2', 'personnel', 'relocation', array['javascript:alert(1)'])$q$, 'evidence_urls', 'validation: non-https evidence refused');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('D1.0'), 'bad name!', 'personnel', 'relocation')$q$, 'Invalid Roblox username', 'validation: invalid username refused');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, occurred_at)
    values (tests.offense('D1.0'), 'Lost_3', 'personnel', 'relocation', now() + interval '1 day')$q$, 'future', 'validation: future date refused');

  -- Permissions
  perform tests.throws(format($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, agent_id)
    values (tests.offense('A5.0'), 'Other_1', 'personnel', 'warning', %L)$q$, tests.id('trooper_b')), 'row-level security|officers', 'trooper: cannot log on behalf of someone else');
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set notes = 'ok' where id = %L$q$, tests.id('log_trooper_a_arrest'))) = 1,
    'trooper: edits own recent log');
  perform tests.throws(format($q$update public.sanction_logs set status = 'voided', void_reason = 'test' where id = %L$q$, tests.id('log_trooper_a_arrest')),
    'officers', 'trooper: cannot void');
  perform tests.throws(format($q$update public.sanction_logs set deleted_at = now() where id = %L$q$, tests.id('log_trooper_a_arrest')),
    'manager', 'trooper: cannot soft delete');
  perform tests.throws(format($q$update public.sanction_logs set counts_for_warnings = false where id = %L$q$, tests.id('log_trooper_a_arrest')),
    'officers', 'trooper: cannot reset warnings by hand');
  perform tests.ok(tests.affected(format('delete from public.sanction_logs where id = %L', tests.id('log_trooper_a_arrest'))) = 0,
    'trooper: cannot hard delete');
  perform tests.throws($q$insert into public.warning_resets (target_normalized, reason) values ('bad_guy_1', 'test')$q$,
    'officers|row-level security', 'trooper: cannot reset warnings');
  perform tests.throws($q$select public.merge_players('Bad_Guy_1', 'Bad_Guy_9')$q$, 'manager', 'trooper: cannot merge players');
  perform tests.ok(tests.count_rows('select 1 from public.audit_log') = 0, 'trooper: cannot read audit_log');
  perform tests.ok(tests.affected($q$update public.offenses set name = 'hack' where code = 'A5.0'$q$) = 0, 'trooper: cannot edit offenses');
  perform tests.throws($q$insert into public.offenses (code, procedure, name, target, default_action) values ('L1.0', 'lima', 'Test', 'immigrant', 'search')$q$,
    'row-level security', 'trooper: cannot create offenses');
  perform tests.throws($q$update public.profiles set role = 'manager' where id = tests.id('trooper_a')$q$, 'manager', 'trooper: cannot promote itself');
  perform tests.ok(tests.affected($q$update public.profiles set roblox_username = 'Hacked_1' where id = tests.id('trooper_b')$q$) = 0,
    'trooper: cannot edit another profile');
  perform tests.ok(tests.count_rows('select 1 from public.profiles') >= 9, 'trooper: reads member list');
end $$;
reset role;

-- trooper_b's own log (used for squad rules)
select tests.login(tests.id('trooper_b'));
do $$
declare l public.sanction_logs%rowtype;
begin
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
  values (tests.offense('A7.0'), 'Bad_Guy_5', 'personnel', 'warning') returning * into l;
  insert into tests.ids values ('log_trooper_b', l.id);
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set notes = 'hack' where id = %L$q$, tests.id('log_trooper_a_arrest'))) = 0,
    'trooper: cannot edit another trooper''s log');
end $$;
reset role;

-- Trooper's 24 h window (system context ages the log)
alter table public.sanction_logs disable trigger sanction_logs_before_write;
update public.sanction_logs set created_at = now() - interval '25 hours' where id = tests.id('log_trooper_b');
alter table public.sanction_logs enable trigger sanction_logs_before_write;
select tests.login(tests.id('trooper_b'));
do $$ begin
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set notes = 'late' where id = %L$q$, tests.id('log_trooper_b'))) = 0,
    'trooper: cannot edit own log after 24 h');
end $$;
reset role;

-- -----------------------------------------------------------------------------
-- read_only
-- -----------------------------------------------------------------------------
select tests.login(tests.id('reader'));
do $$ begin
  perform tests.ok(tests.count_rows('select 1 from public.sanction_logs') >= 10, 'read_only: reads logs');
  perform tests.ok(tests.count_rows($q$select 1 from public.players where target_normalized = 'bad_guy_1'$q$) = 1, 'read_only: reads players view');
  perform tests.ok(tests.count_rows($q$select 1 from public.warning_counters where target_normalized = 'bad_guy_1' and code = 'A5.0' and warnings_given = 3 and arrest_authorized$q$) = 1,
    'read_only: warning_counters shows 3/3 arrest authorized');
  perform tests.ok((public.dashboard_stats('Europe/Paris') ->> 'today')::int >= 10, 'read_only: dashboard stats');
  perform tests.ok(public.dashboard_stats() -> 'pending_approvals' = 'null'::jsonb, 'read_only: no pending approvals figure');
  perform tests.ok(tests.count_rows(format('select * from public.get_log_history(%L)', tests.id('log_trooper_a_arrest'))) >= 2, 'read_only: reads log history');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('A5.0'), 'Someone_2', 'personnel', 'warning')$q$, 'row-level security|role', 'read_only: cannot create a log');
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set notes = 'x' where id = %L$q$, tests.id('log_trooper_b'))) = 0, 'read_only: cannot edit logs');
  perform tests.throws($q$select public.get_recommendation('Someone_2', tests.offense('A5.0'))$q$, 'Access denied', 'read_only: no recommendation RPC');
  perform tests.ok(tests.count_rows('select 1 from public.audit_log') = 0, 'read_only: cannot read audit_log');
end $$;
reset role;

-- -----------------------------------------------------------------------------
-- cs: confirm ⧭ approvals (any squad), edit own squad's logs only
-- -----------------------------------------------------------------------------
select tests.login(tests.id('cs_a'));
do $$ begin
  perform tests.ok((public.dashboard_stats() ->> 'pending_approvals')::int >= 1, 'cs: sees pending approvals count');
  perform public.confirm_approval(tests.id('log_pending_approval'));
  perform tests.ok((select approval_confirmed_by from public.sanction_logs where id = tests.id('log_pending_approval')) = tests.id('cs_a'),
    'cs: confirms a ⧭ approval');
  perform tests.throws(format('select public.confirm_approval(%L)', tests.id('log_pending_approval')), 'already confirmed', 'cs: cannot confirm twice');
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set notes = 'cs edit' where id = %L$q$, tests.id('log_trooper_a_arrest'))) = 1,
    'cs: edits a log of own squad');
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set notes = 'cs edit' where id = %L$q$, tests.id('log_trooper_b'))) = 0,
    'cs: cannot edit a log of another squad (sharing a function does not count)');
  perform tests.throws(format($q$update public.sanction_logs set status = 'voided', void_reason = 'test' where id = %L$q$, tests.id('log_trooper_a_arrest')),
    'officers', 'cs: cannot void');
  perform tests.throws($q$insert into public.warning_resets (target_normalized, reason) values ('bad_guy_1', 'test')$q$,
    'officers|row-level security', 'cs: cannot reset warnings');
end $$;
reset role;

select tests.login(tests.id('cs_b'));
do $$ begin
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set notes = 'cs_b edit' where id = %L$q$, tests.id('log_trooper_a_arrest'))) = 1,
    'cs: multiple squads - edits a log through a second shared squad');
  perform tests.ok(tests.count_rows(format($q$select 1 from public.sanction_logs_expanded where id = %L and %L = any(agent_squad_ids)$q$,
    tests.id('log_trooper_a_arrest'), tests.id('squad_c'))) = 1, 'view: agent_squad_ids lists every squad of the agent');
  perform tests.ok(tests.count_rows(format($q$select 1 from public.sanction_logs_expanded where id = %L and %L = any(agent_squad_ids)$q$,
    tests.id('log_trooper_b'), tests.id('function'))) = 0, 'view: functions are not listed in agent_squad_ids');
end $$;
reset role;

select tests.login(tests.id('trooper_a'));
do $$ begin
  perform tests.ok(tests.count_rows('select 1 from public.profile_squads') >= 8, 'memberships: readable by members');
  perform tests.throws(format($q$insert into public.profile_squads (profile_id, squad_id) values (%L, %L)$q$, tests.id('trooper_a'), tests.id('squad_b')),
    'row-level security', 'memberships: a trooper cannot join a squad');
  perform tests.ok(tests.affected(format($q$delete from public.profile_squads where profile_id = %L$q$, tests.id('trooper_a'))) = 0,
    'memberships: a trooper cannot leave a squad');
end $$;
reset role;

select tests.login(tests.id('pending'));
do $$ begin
  perform tests.ok(tests.count_rows('select 1 from public.profile_squads') = 0, 'memberships: pending sees none');
end $$;
reset role;

-- -----------------------------------------------------------------------------
-- officer: void, reset, log on behalf, no delete / merge / audit
-- -----------------------------------------------------------------------------
select tests.login(tests.id('officer'));
do $$
declare v_reset public.warning_resets%rowtype; r jsonb; l public.sanction_logs%rowtype;
begin
  perform tests.throws(format($q$update public.sanction_logs set status = 'voided' where id = %L$q$, tests.id('log_trooper_b')),
    'void reason', 'officer: void requires a reason');
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set status = 'voided', void_reason = 'Wrong target' where id = %L$q$, tests.id('log_trooper_b'))) = 1,
    'officer: voids any log');
  perform tests.ok((select voided_by from public.sanction_logs where id = tests.id('log_trooper_b')) = tests.id('officer'), 'officer: voided_by recorded');

  insert into public.warning_resets (target_normalized, offense_id, reason)
  values ('BAD_GUY_1', tests.offense('A5.0'), 'Good conduct') returning * into v_reset;
  perform tests.ok(v_reset.logs_affected = 4 and v_reset.reset_by = tests.id('officer'), 'officer: resets warnings (4 logs flagged)', v_reset.logs_affected::text);
  r := public.get_recommendation('Bad_Guy_1', tests.offense('A5.0'));
  perform tests.ok(r ->> 'recommendation_code' = 'warning' and (r ->> 'recommended_warning_number')::int = 1, 'reset: back to Warning 1/3', r::text);

  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, agent_id)
  values (tests.offense('A5.0'), 'Bad_Guy_6', 'personnel', 'warning', tests.id('trooper_a')) returning * into l;
  perform tests.ok(l.agent_id = tests.id('trooper_a') and l.created_by = tests.id('officer'), 'officer: logs on behalf of a trooper');

  perform tests.throws(format($q$update public.sanction_logs set deleted_at = now() where id = %L$q$, l.id), 'manager', 'officer: cannot soft delete');
  perform tests.ok(tests.affected(format('delete from public.sanction_logs where id = %L', l.id)) = 0, 'officer: cannot hard delete');
  perform tests.throws($q$select public.merge_players('Bad_Guy_1', 'Bad_Guy_9')$q$, 'manager', 'officer: cannot merge');
  perform tests.ok(tests.count_rows('select 1 from public.audit_log') = 0, 'officer: cannot read audit_log');
  perform tests.throws($q$update public.profiles set role = 'manager' where id = tests.id('officer')$q$, 'manager', 'officer: cannot change its own role');
  perform tests.ok(tests.affected($q$update public.profiles set role = 'officer' where id = tests.id('trooper_a')$q$) = 0, 'officer: cannot change others'' roles');
end $$;
reset role;

-- -----------------------------------------------------------------------------
-- manager: everything, audit, merge, delete
-- -----------------------------------------------------------------------------
select tests.login(tests.id('manager'));
do $$
declare n integer; l public.sanction_logs%rowtype;
begin
  perform tests.ok(tests.count_rows('select 1 from public.audit_log') > 20, 'manager: reads audit_log');
  insert into public.profile_squads (profile_id, squad_id) values (tests.id('reader'), tests.id('squad_a')), (tests.id('reader'), tests.id('function'));
  perform tests.ok(tests.count_rows(format('select 1 from public.profile_squads where profile_id = %L', tests.id('reader'))) = 2, 'manager: adds a member to several units');
  perform tests.ok(tests.affected(format('delete from public.profile_squads where profile_id = %L', tests.id('reader'))) = 2, 'manager: removes memberships');
  perform tests.ok(tests.count_rows($q$select 1 from public.audit_log where table_name = 'profile_squads' and row_id is not null$q$) >= 2, 'audit: memberships are logged');
  perform tests.throws('delete from public.audit_log', 'permission denied|append-only', 'manager: cannot delete audit entries');
  perform tests.throws('update public.audit_log set action = ''INSERT''', 'permission denied|append-only', 'manager: cannot alter audit entries');

  perform tests.throws($q$update public.profiles set role = 'officer' where id = tests.id('manager')$q$, 'last active manager', 'manager: last active manager protected');
  perform tests.ok(tests.affected($q$update public.profiles set role = 'cs' where id = tests.id('trooper_b')$q$) = 1, 'manager: changes roles');

  perform tests.ok(tests.affected(format($q$update public.sanction_logs set deleted_at = now() where id = %L$q$, tests.id('log_trooper_b'))) = 1, 'manager: soft deletes');

  n := public.merge_players('Bad_Guy_1', 'Good_Guy_1', 'Username change');
  perform tests.ok(n = 4, 'manager: merges two usernames', n::text);
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
  values (tests.offense('A5.0'), 'bad_guy_1', 'personnel', 'warning') returning * into l;
  perform tests.ok(l.target_normalized = 'good_guy_1' and l.target_username = 'bad_guy_1', 'merge: old username is filed under the new one');
  perform tests.ok(public.unmerge_player('bad_guy_1') >= 1, 'manager: undoes a merge');

  insert into public.offenses (code, procedure, name, target, default_action) values ('L1.0', 'lima', 'Test search', 'immigrant', 'search');
  perform tests.ok(tests.count_rows($q$select 1 from public.offenses where code = 'L1.0'$q$) = 1, 'manager: adds a Lima offense');
  perform tests.throws($q$insert into public.offenses (code, procedure, name, target, default_action) values ('A99.0', 'hotel', 'Bad prefix', 'both', 'detention')$q$,
    'offenses_code_matches_procedure', 'catalog: code prefix must match procedure');
  perform tests.throws($q$delete from public.offenses where code = 'A5.0'$q$, 'foreign key', 'catalog: used offense cannot be deleted');
end $$;
reset role;

select tests.login(tests.id('officer'));
do $$ begin
  perform tests.ok(tests.count_rows(format('select 1 from public.sanction_logs where id = %L', tests.id('log_trooper_b'))) = 0,
    'soft delete: hidden from officers');
end $$;
reset role;

select tests.login(tests.id('manager'));
do $$ begin
  perform tests.ok(tests.affected(format('delete from public.sanction_logs where id = %L', tests.id('log_trooper_b'))) = 1, 'manager: hard deletes');
  perform tests.ok(tests.count_rows($q$select 1 from public.audit_log where table_name = 'sanction_logs' and action = 'DELETE'$q$) >= 1,
    'audit: hard delete keeps a copy');
end $$;
reset role;

-- Even the table owner cannot rewrite history
do $$ begin
  perform tests.throws('delete from public.audit_log', 'append-only', 'owner: audit_log is append-only');
end $$;

-- -----------------------------------------------------------------------------
-- Report (intentional error = rollback of all test data)
-- -----------------------------------------------------------------------------
do $$
declare
  v_total integer;
  v_failed integer;
  v_list text;
begin
  select count(*), count(*) filter (where not ok) into v_total, v_failed from tests.results;
  select string_agg(format('[%s] %s: %s', id, label, coalesce(detail, '')), E'\n' order by id)
    into v_list from tests.results where not ok;
  if v_failed = 0 then
    raise exception 'ALL TESTS PASSED (%/%). This error is intentional: it rolls back every test row.', v_total, v_total;
  else
    raise exception E'TESTS FAILED (%/%):\n%', v_failed, v_total, v_list;
  end if;
end $$;

rollback;

-- Edge-case and hostile-input tests (code review). Appended after the
-- harness + fixtures of supabase/tests.sql by tests_revue/run-edge.mjs.

-- ---------------------------------------------------------------- trooper inputs
select tests.login(tests.id('trooper_a'));
do $$
declare l public.sanction_logs%rowtype; r jsonb; i int; urls text[];
begin
  -- E1 HTML is stored verbatim (escaping is the front's job)
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, notes)
  values (tests.offense('D1.0'), 'Html_Guy', 'personnel', 'relocation', '<img src=x onerror=alert(1)>') returning * into l;
  perform tests.ok(l.notes = '<img src=x onerror=alert(1)>', 'E1 notes with HTML stored verbatim');

  -- E2 evidence URL rules
  select array_agg('https://example.com/' || g) into urls from generate_series(1, 11) g;
  perform tests.throws(format($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, evidence_urls)
    values (tests.offense('D1.0'), 'Url_Guy', 'personnel', 'relocation', %L)$q$, urls), 'evidence_urls', 'E2a 11 evidence URLs refused');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, evidence_urls)
    values (tests.offense('D1.0'), 'Url_Guy', 'personnel', 'relocation', array['http://example.com/a.png'])$q$, 'evidence_urls', 'E2b http:// refused');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, evidence_urls)
    values (tests.offense('D1.0'), 'Url_Guy', 'personnel', 'relocation', array['https://exa mple.com/a'])$q$, 'evidence_urls', 'E2c URL with space refused');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, evidence_urls)
  values (tests.offense('D1.0'), 'Url_Guy', 'personnel', 'relocation', array['  https://i.imgur.com/a.png  ', '', '   ']) returning * into l;
  perform tests.ok(l.evidence_urls = array['https://i.imgur.com/a.png'], 'E2d URLs trimmed and blanks dropped', l.evidence_urls::text);

  -- E3 jail bounds and jail on non-jail action
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, jail_seconds)
    values (tests.offense('A2.0'), 'Jail_Guy', 'personnel', 'arrest', 0)$q$, 'jail_seconds', 'E3a jail 0 refused');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, jail_seconds)
    values (tests.offense('A2.0'), 'Jail_Guy', 'personnel', 'arrest', 86401)$q$, 'jail_seconds', 'E3b jail 86401 refused');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, jail_seconds)
  values (tests.offense('A5.0'), 'Jail_Guy', 'personnel', 'warning', 999) returning * into l;
  perform tests.ok(l.jail_seconds is null, 'E3c jail dropped on a warning');

  -- E4 future-date tolerance (5 minutes)
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, occurred_at)
  values (tests.offense('D1.0'), 'Clock_Guy', 'personnel', 'relocation', now() + interval '4 minutes') returning * into l;
  perform tests.ok(l.id is not null, 'E4a +4 min accepted (clock skew)');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, occurred_at)
    values (tests.offense('D1.0'), 'Clock_Guy', 'personnel', 'relocation', now() + interval '6 minutes')$q$, 'future', 'E4b +6 min refused');

  -- E5/E6 lengths
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, override_reason)
    values (tests.offense('A6.0'), 'Len_Guy', 'personnel', 'arrest', 'ab')$q$, 'override_reason|justification', 'E5a 2-char override reason refused');
  perform tests.throws(format($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, override_reason)
    values (tests.offense('A6.0'), 'Len_Guy', 'personnel', 'arrest', %L)$q$, repeat('x', 501)), 'override_reason', 'E5b 501-char override reason refused');
  perform tests.throws(format($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, location)
    values (tests.offense('D1.0'), 'Len_Guy', 'personnel', 'relocation', %L)$q$, repeat('x', 121)), 'location', 'E6 121-char location refused');
  perform tests.throws(format($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, notes)
    values (tests.offense('D1.0'), 'Len_Guy', 'personnel', 'relocation', %L)$q$, repeat('x', 4001)), 'notes', 'E6b 4001-char notes refused');

  -- E7 hostile usernames
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('D1.0'), 'x''; drop table x;--', 'personnel', 'relocation')$q$, 'Invalid Roblox username', 'E7a SQL-ish username refused');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('D1.0'), 'Ünïcødé_Guy', 'personnel', 'relocation')$q$, 'Invalid Roblox username', 'E7b unicode username refused');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
  values (tests.offense('D1.0'), '  Spaced_Guy  ', 'personnel', 'relocation') returning * into l;
  perform tests.ok(l.target_username = 'Spaced_Guy' and l.target_normalized = 'spaced_guy', 'E7c username trimmed and normalized');

  -- E8 HICOM/ISB order: Alpha offense on an immigrant allowed, target type kept
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, order_type, ordered_by)
  values (tests.offense('A2.0'), 'Immi_Order', 'immigrant', 'arrest', 'hicom_isb_order', 'HICOM') returning * into l;
  perform tests.ok(l.target_type = 'immigrant', 'E8a HICOM/ISB order keeps immigrant target on an Alpha offense');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, order_type, ordered_by)
  values (tests.offense('A5.0'), 'Immi_Order', 'personnel', 'termination', 'hicom_isb_order', 'ISB') returning * into l;
  perform tests.ok(l.is_override and l.override_reason is null, 'E8b HICOM/ISB override accepted without justification');

  -- E10 AOS order: immediate arrest, not an override
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, order_type, ordered_by)
  values (tests.offense('A5.0'), 'Aos_Guy', 'personnel', 'arrest', 'arrest_on_sight', 'Lt. Kael') returning * into l;
  perform tests.ok(l.recommendation_code = 'order_arrest' and not l.is_override and l.jail_seconds = 120, 'E10 AOS order -> arrest recommended, jail 120');

  -- E11 forcing a 4th warning when the arrest is authorized
  for i in 1..3 loop
    insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('A5.0'), 'Four_Guy', 'personnel', 'warning');
  end loop;
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, override_reason)
  values (tests.offense('A5.0'), 'Four_Guy', 'personnel', 'warning', 'Last chance given') returning * into l;
  perform tests.ok(l.warning_number = 4 and l.is_override and l.recommendation_code = 'arrest_authorized', 'E11 forced 4th warning recorded as override, number 4');
  insert into tests.ids values ('four_guy_w4', l.id);

  -- E12 recommendation with an unknown offense
  perform tests.throws($q$select public.get_recommendation('Four_Guy', '00000000-0000-0000-0000-000000000000')$q$, 'Unknown offense', 'E12 unknown offense -> clear error');
  perform tests.throws($q$select public.get_recommendation('Four_Guy', null)$q$, 'Unknown offense', 'E12b null offense -> clear error');

  -- E13 dashboard with hostile time zone
  perform tests.ok(public.dashboard_stats($q$UTC'; drop table x;--$q$) ->> 'timezone' = 'UTC', 'E13 hostile time zone falls back to UTC');

  -- E20 self-rename after approval
  perform tests.throws($q$update public.profiles set roblox_username = 'Renamed_Trooper' where id = tests.id('trooper_a')$q$, 'only be changed by the manager',
    'E20 (fixed D2) an approved trooper can no longer rename themself');

  -- E33 trooper cannot reassign the agent of their own log
  perform tests.throws(format($q$update public.sanction_logs set agent_id = %L where id = %L$q$, tests.id('trooper_b'), tests.id('four_guy_w4')),
    'officers', 'E33 trooper cannot reassign the agent of their log');

  -- E34 trooper names an approver on a ⧭ WARNING (no arrest)
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, approved_by)
  values (tests.offense('A10.0'), 'Warn_Approve', 'personnel', 'warning', tests.id('cs_a')) returning * into l;
  insert into tests.ids values ('warn_with_approver', l.id);
  perform tests.ok(l.approved_by is null,
    'E34 (fixed D1) a ⧭ warning no longer carries an approver');
end $$;
reset role;

-- ---------------------------------------------------------------- approval & lifecycle
select tests.login(tests.id('officer'));
do $$
declare r jsonb; v_w2 uuid; l public.sanction_logs%rowtype;
begin
  -- E14 soft-deleting a middle warning lowers the prior count
  select id into v_w2 from public.sanction_logs where target_normalized = 'four_guy' and warning_number = 2;
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set status = 'voided', void_reason = 'Duplicate' where id = %L$q$, v_w2)) = 1, 'E14a officer voids warning 2');
  r := public.get_recommendation('Four_Guy', tests.offense('A5.0'));
  perform tests.ok((r ->> 'prior_warnings')::int = 3, 'E14b voided warning no longer counts (4 -> 3)', r::text);
  perform tests.ok(tests.affected(format($q$update public.sanction_logs set status = 'valid' where id = %L$q$, v_w2)) = 1, 'E14c officer restores it');
  r := public.get_recommendation('Four_Guy', tests.offense('A5.0'));
  perform tests.ok((r ->> 'prior_warnings')::int = 4, 'E14d restored warning counts again', r::text);
  perform tests.ok((select void_reason is null and voided_by is null from public.sanction_logs where id = v_w2), 'E14e restore clears void fields');

  -- E15 officer cannot tamper with created_by / log_number
  perform tests.throws(format($q$update public.sanction_logs set created_by = %L where id = %L$q$, tests.id('officer'), v_w2), 'Read-only', 'E15a created_by is immutable');
  perform tests.throws(format($q$update public.sanction_logs set log_number = 'LOG-2026-99999' where id = %L$q$, v_w2), 'Read-only', 'E15b log_number is immutable');

  -- E16 reset of ALL offenses for a player
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
  values (tests.offense('A6.0'), 'Four_Guy', 'personnel', 'warning');
  insert into public.warning_resets (target_normalized, offense_id, reason) values ('FOUR_GUY', null, 'Clean slate') ;
  perform tests.ok((public.get_recommendation('Four_Guy', tests.offense('A5.0')) ->> 'prior_warnings')::int = 0
    and (public.get_recommendation('Four_Guy', tests.offense('A6.0')) ->> 'prior_warnings')::int = 0, 'E16 reset with no offense clears every counter');

  -- E17 backdated warning before a reset does not count
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, occurred_at)
  values (tests.offense('A5.0'), 'Four_Guy', 'personnel', 'warning', now() - interval '2 days') returning * into l;
  perform tests.ok(not l.counts_for_warnings, 'E17 backdated log older than the reset does not count');

  -- E18 changing a log to an inactive offense
  update public.offenses set active = false where code = 'A7.0';
end $$;
reset role;

select tests.login(tests.id('manager'));
do $$ begin
  update public.offenses set active = false where code = 'A7.0';
end $$;
reset role;

select tests.login(tests.id('officer'));
do $$
declare v_id uuid;
begin
  select id into v_id from public.sanction_logs where target_normalized = 'four_guy' and warning_number = 1 limit 1;
  perform tests.throws(format($q$update public.sanction_logs set offense_id = tests.offense('A7.0') where id = %L$q$, v_id), 'inactive', 'E18a moving a log to an inactive offense refused');
  perform tests.throws($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken)
    values (tests.offense('A7.0'), 'Dead_Offense', 'personnel', 'warning')$q$, 'inactive', 'E18b new log on an inactive offense refused');
end $$;
reset role;

select tests.login(tests.id('manager'));
do $$
declare n int; r jsonb; l public.sanction_logs%rowtype;
begin
  update public.offenses set active = true where code = 'A7.0';

  -- E19 merge chain A -> B then B -> C
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken) values (tests.offense('D1.0'), 'Chain_A', 'personnel', 'relocation');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken) values (tests.offense('D1.0'), 'Chain_B', 'personnel', 'relocation');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken) values (tests.offense('D1.0'), 'Chain_C', 'personnel', 'relocation');
  perform public.merge_players('Chain_A', 'Chain_B');
  perform public.merge_players('Chain_B', 'Chain_C');
  perform tests.ok((select count(*) from public.sanction_logs where target_normalized = 'chain_c') = 3, 'E19a chained merges gather all logs in the last record');
  perform tests.ok((select canonical_normalized from public.player_aliases where alias_normalized = 'chain_a') = 'chain_c', 'E19b first alias re-pointed to the final record');
  insert into public.sanction_logs (offense_id, target_username, target_type, action_taken) values (tests.offense('D1.0'), 'CHAIN_A', 'personnel', 'relocation') returning * into l;
  perform tests.ok(l.target_normalized = 'chain_c', 'E19c a new log typed with the oldest alias lands in the final record');
  perform tests.throws($q$select public.merge_players('Chain_A', 'Chain_C')$q$, 'same player', 'E19d merging an alias into its own record refused');
  perform tests.throws($q$select public.merge_players('Chain_C', 'Chain_C')$q$, 'same player', 'E19e merging into itself refused');
  n := public.unmerge_player('chain_b');
  perform tests.ok(n = 1 and (select count(*) from public.sanction_logs where target_normalized = 'chain_b') = 1, 'E19f unmerge returns only the logs typed with that alias', n::text);
  perform tests.throws($q$select public.unmerge_player('chain_b')$q$, 'not found', 'E19g unmerging twice -> clear error');

  -- E22 deactivated CS cannot be named approver
  update public.profiles set active = false where id = tests.id('cs_b');
  perform tests.throws(format($q$insert into public.sanction_logs (offense_id, target_username, target_type, action_taken, approved_by)
    values (tests.offense('A12.0'), 'Inact_Appr', 'personnel', 'arrest', %L)$q$, tests.id('cs_b')), 'approver must be', 'E22 deactivated CS refused as approver');
  update public.profiles set active = true where id = tests.id('cs_b');

  -- E28 deleting a squad removes its memberships, audited
  delete from public.squads where id = tests.id('squad_c');
  perform tests.ok((select count(*) from public.profile_squads where squad_id = tests.id('squad_c')) = 0, 'E28a deleting a squad cascades memberships');
  perform tests.ok((select count(*) from public.audit_log where table_name = 'profile_squads' and action = 'DELETE') >= 2, 'E28b cascaded membership deletions are audited');
end $$;
reset role;

-- ---------------------------------------------------------------- RPC permissions for low roles
select tests.login(tests.id('reader'));
do $$ begin
  perform tests.throws(format('select public.confirm_approval(%L)', tests.id('four_guy_w4')), 'Only a CS', 'E30 read_only cannot confirm approvals');
  perform tests.throws($q$select public.merge_players('Chain_C', 'Chain_B')$q$, 'Only the manager', 'E30b read_only cannot merge');
  perform tests.throws($q$select public.unmerge_player('chain_a')$q$, 'Only the manager', 'E30c read_only cannot unmerge');
end $$;
reset role;

select tests.login(tests.id('pending'));
do $$ begin
  perform tests.throws(format('select * from public.get_log_history(%L)', tests.id('four_guy_w4')), 'Access denied', 'E29a pending cannot read history');
  perform tests.throws($q$select public.merge_players('Chain_C', 'Chain_B')$q$, 'Only the manager', 'E29b pending cannot merge');
end $$;
reset role;

-- ---------------------------------------------------------------- username sign-in edge cases
set local role anon;
do $$ begin
  perform tests.ok(public.resolve_login_email('  Test_Trooper_A  ', 'Correct-Horse-1') ->> 'email' = 'test-trooper-a@cst.test', 'E27a identifier is trimmed');
  perform tests.ok(public.resolve_login_email('Test_Trooper_A', repeat('x', 201)) ->> 'email' is null, 'E27b 201-char password returns nothing');
  perform tests.ok(public.resolve_login_email('Test_Trooper_A', null) ->> 'email' is null, 'E27c null password returns nothing');
  perform tests.ok(public.resolve_login_email(null, 'x') ->> 'email' is null, 'E27d null identifier returns nothing');
  perform tests.ok(public.resolve_login_email($q$a' or '1'='1$q$, 'x') ->> 'email' is null, 'E27e SQL-ish identifier returns nothing');
  perform tests.ok(public.resolve_login_email('Test_Pending_2', 'anything') ->> 'email' is null, 'E27f account without password hash returns nothing');
end $$;
reset role;

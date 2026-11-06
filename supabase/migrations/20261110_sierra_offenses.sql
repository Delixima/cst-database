-- =============================================================================
-- Migration 2026-11-09 (2/2): Sierra procedure - prefix, constraint, view, offenses
--
-- Sierra = cuff, jail or terminate Divisional personnel (code letter S).
-- Adds: prefix S, code check accepting S, players.sierra_count, and the
-- 12 Sierra offenses. Existing logs and offenses are untouched.
--
-- Run ONCE in the Supabase SQL Editor, after 20261109_sierra_enum.sql
-- (which must already have been run and committed).
-- A fresh install does not need this file: schema.sql already contains it.
-- =============================================================================

begin;

-- 1. Code letter
create or replace function private.procedure_prefix(p public.procedure_code)
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

-- 2. Code format check: accept S (the auto-named check is found by definition)
do $$
declare
  c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.offenses'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%[AFTDLH]%'
  loop
    execute format('alter table public.offenses drop constraint %I', c);
  end loop;
end $$;

alter table public.offenses
  add constraint offenses_code_format_check
  check (code ~ '^[AFTDLHS][0-9]{1,3}\.[0-9]{1,2}$');

-- 3. players view: sierra_count (appended last, as CREATE OR REPLACE requires)
create or replace view public.players
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
  coalesce(
    (select array_agg(a.alias_normalized order by a.alias_normalized)
       from public.player_aliases a
      where a.canonical_normalized = l.target_normalized),
    '{}'::text[]
  )                                                                            as aliases,
  count(*) filter (where l.status = 'valid' and l.procedure = 'sierra')         as sierra_count
from public.sanction_logs l
where l.deleted_at is null
group by l.target_normalized;

-- 4. Sierra offenses (jail durations are an assumption: adjust them in the
--    Offense catalog page if the guide says otherwise)
insert into public.offenses
  (code, procedure, name, target, jail_seconds, max_warnings, default_action, requires_cs_approval, report_required)
values
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
  ('S12.0', 'sierra', 'Being terminated for entering an ERG, CST or IDT VIP''s killzone 2 times', 'personnel', 120, 2, 'arrest', false, false)
on conflict (code) do nothing;

commit;

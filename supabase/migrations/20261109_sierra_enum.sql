-- =============================================================================
-- Migration 2026-11-09 (1/2): Sierra procedure - enum value
--
-- Postgres cannot use a new enum value in the transaction that creates it,
-- so this file is separate and must be run FIRST, on its own.
--
-- Run ONCE in the Supabase SQL Editor, after 20261108_review_fixes.sql.
-- Then run 20261110_sierra_offenses.sql.
-- A fresh install does not need this file: schema.sql already contains it.
-- =============================================================================

begin;
alter type public.procedure_code add value if not exists 'sierra';
commit;

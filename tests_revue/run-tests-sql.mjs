// Runs schema.sql then tests.sql on PGlite with a minimal Supabase stub.
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';

const [schemaPath, testsPath] = process.argv.slice(2);
const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; create schema extensions;
  grant usage on schema public, auth, extensions to anon, authenticated, service_role;
  create table auth.users (id uuid primary key default gen_random_uuid(), aud text, role text, email text, raw_user_meta_data jsonb default '{}'::jsonb, encrypted_password text);
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(current_setting('request.jwt.claim.sub', true), (auth.jwt() ->> 'sub')), '')::uuid $$;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`);
await db.exec(readFileSync(schemaPath, 'utf8'));
console.log('schema OK');
try {
  await db.exec(readFileSync(testsPath, 'utf8'));
  console.log('UNEXPECTED: tests.sql finished without the report error');
  process.exit(1);
} catch (e) {
  console.log(e.message);
  process.exit(/^ALL TESTS PASSED/.test(e.message) ? 0 : 1);
}

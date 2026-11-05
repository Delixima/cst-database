// Runs the whole local test suite:
//   1. supabase/tests.sql on a fresh install (schema.sql)
//   2. supabase/tests.sql on the production upgrade path
//      (original schema from commit 496e31b + every file in supabase/migrations, in name order)
//   3. edge-case tests (edge_body.sql) on both paths
//   4. front-end unit tests (unit.mjs)
// Exit code 0 only if everything passes.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BASE_COMMIT = '496e31b'; // schema first installed on the live database

const original = execFileSync('git', ['show', `${BASE_COMMIT}:supabase/schema.sql`], { cwd: root, encoding: 'utf8' });
const migrationsDir = join(root, 'supabase', 'migrations');
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const prodPath = join(here, '_prod_path.sql');
writeFileSync(prodPath, [original, ...migrations.map((f) => readFileSync(join(migrationsDir, f), 'utf8'))].join('\n'));

const fresh = join(root, 'supabase', 'schema.sql');
const testsSql = join(root, 'supabase', 'tests.sql');
const runner = join(here, 'run-tests-sql.mjs');

function run(label, args) {
  let out;
  try {
    out = execFileSync('node', args, { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const line = out.split('\n').find((l) => /TESTS PASSED|TESTS FAILED|UNIT TESTS|FAILED/.test(l)) ?? out.trim().split('\n').slice(-3).join(' ');
  const passed = /^ALL .*PASSED/.test(line.trim());
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${line.trim()}`);
  if (!passed) console.log(out.split('\n').filter((l) => /^\[\d+\]/.test(l)).join('\n'));
  return passed;
}

console.log(`Production path: ${BASE_COMMIT} + ${migrations.join(', ')}\n`);
const results = [
  run('tests.sql — fresh install', [runner, fresh, testsSql]),
  run('tests.sql — production upgrade path', [runner, prodPath, testsSql]),
  run('edge cases — fresh install', ['run-edge.mjs', fresh, runner]),
  run('edge cases — production upgrade path', ['run-edge.mjs', prodPath, runner]),
  run('front-end unit tests', ['unit.mjs']),
];
const ok = results.every(Boolean);
console.log(ok ? '\nALL SUITES PASSED' : '\nSOME SUITES FAILED');
process.exit(ok ? 0 : 1);

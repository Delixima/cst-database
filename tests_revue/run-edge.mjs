// Builds tests_revue/edge.sql = harness + fixtures of supabase/tests.sql + edge_body.sql + report,
// then runs it with run-tests-sql.mjs on the given schema file.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tests = readFileSync(join(root, 'supabase/tests.sql'), 'utf8').replace(/\r\n/g, '\n');
const fixturesEnd = tests.indexOf('-- -----------------------------------------------------------------------------\n-- anon: no access at all');
const reportStart = tests.indexOf('-- -----------------------------------------------------------------------------\n-- Report (intentional error');
if (fixturesEnd < 0 || reportStart < 0) throw new Error('tests.sql markers not found');
const sql = tests.slice(0, fixturesEnd) + readFileSync(join(here, 'edge_body.sql'), 'utf8') + '\n' + tests.slice(reportStart);
writeFileSync(join(here, 'edge.sql'), sql);

const runner = process.argv[3] || join(here, 'run-tests-sql.mjs');
const schema = process.argv[2];
try {
  const out = execFileSync('node', [runner, schema, join(here, 'edge.sql')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(out);
} catch (e) {
  console.log((e.stdout || '') + (e.stderr || '').split('\n').filter((l) => !/^\s+at /.test(l)).join('\n'));
}

// Unit tests of the pure front-end helpers (no DOM, no network).
// Run: node tests_revue/unit.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');
const imp = (f) => import(pathToFileURL(join(root, f)).href);
const format = await imp('format.js');
const csv = await imp('csv.js');
const labels = await imp('labels.js');
const ui = await imp('ui.js');

// auth.js imports the CDN client, so evaluate safeNext from its source.
const authSrc = readFileSync(join(root, 'auth.js'), 'utf8').split('\r\n').join('\n');
const safeNextSrc = /export function safeNext[\s\S]*?\n}\n/.exec(authSrc)[0].replace('export ', '');
const safeNext = new Function(`${safeNextSrc}; return safeNext;`)();

let fail = 0, total = 0;
const ok = (cond, label, detail = '') => { total++; if (!cond) { fail++; console.log('FAIL', label, detail); } };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);

// ---------------------------------------------------------------- evidence URLs (must mirror SQL)
eq(format.isValidEvidenceUrl('https://i.imgur.com/a.png'), true, 'url: https ok');
eq(format.isValidEvidenceUrl('http://i.imgur.com/a.png'), false, 'url: http refused');
eq(format.isValidEvidenceUrl('javascript:alert(1)'), false, 'url: javascript refused');
eq(format.isValidEvidenceUrl('https://a b.com/x'), false, 'url: space refused');
eq(format.isValidEvidenceUrl('https://x.c'), false, 'url: 11 chars refused (SQL: 12..2048)');
eq(format.isValidEvidenceUrl('https://x.co'), true, 'url: 12 chars accepted (same bound as SQL)');
eq(format.isValidEvidenceUrl('https://x.com'), true, 'url: 13 chars ok');
eq(format.isValidEvidenceUrl('https://example.com/' + 'a'.repeat(2028)), true, 'url: 2048 chars ok');
eq(format.isValidEvidenceUrl('https://example.com/' + 'a'.repeat(2029)), false, 'url: 2049 chars refused');
eq(format.isValidEvidenceUrl('https://example.com/"onmouseover=x'), false, 'url: quote refused');
eq(format.isValidEvidenceUrl("https://example.com/'x"), false, 'url: apostrophe refused');
eq(format.isValidEvidenceUrl('https://example.com/<b>'), false, 'url: angle bracket refused');
eq(format.isValidEvidenceUrl(null), false, 'url: null refused');

eq(format.looksLikeImage('https://cdn.example.com/shot.PNG?x=1'), true, 'image: extension case-insensitive with query');
eq(format.looksLikeImage('https://media.discordapp.net/attachments/1/2/file'), true, 'image: discord media host');
eq(format.looksLikeImage('https://youtube.com/watch?v=1'), false, 'image: youtube not an image');
eq(format.looksLikeImage('not a url'), false, 'image: garbage');

// ---------------------------------------------------------------- misc formatting
eq(format.escapeLike('a_b%c\\d'), 'a\\_b\\%c\\\\d', 'escapeLike escapes _ % and backslash');
eq(format.fmtJail(null), '—', 'fmtJail null');
eq(format.fmtJail(45), '45 s', 'fmtJail < 60');
eq(format.fmtJail(120), '120 s (2 min)', 'fmtJail 120');
eq(format.fmtJail(150), '150 s (2 min 30 s)', 'fmtJail 150');
const d = new Date(2026, 10, 5, 9, 7);
eq(format.fromLocalInput(format.toLocalInput(d)), d.toISOString(), 'datetime-local round trip');
eq(format.fromLocalInput(''), null, 'fromLocalInput empty');
eq(format.fromLocalInput('garbage'), null, 'fromLocalInput garbage');
eq(format.dayBoundary('2026-11-05') !== null && format.dayBoundary('2026-11-05', true) > format.dayBoundary('2026-11-05'), true, 'dayBoundary start < end');
eq(format.isUuid('00000000-0000-4000-8000-000000000001'), true, 'isUuid ok');
eq(format.isUuid('../../etc'), false, 'isUuid refuses junk');

// ---------------------------------------------------------------- CSV
const out = csv.toCsv([{ a: '=HYPERLINK("http://evil")', b: 'x;y', c: 'he said "hi"', d: '-2+3', e: ['u1', 'u2'], f: null }],
  ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({ label: k, get: (r) => r[k] })));
const line = out.split('\r\n')[1];
ok(out.startsWith('﻿'), 'csv: BOM present');
ok(line.startsWith('"\'=HYPERLINK(""http://evil"")"'), 'csv: formula neutralised and quoted', line);
ok(line.includes(';"x;y";'), 'csv: separator inside a value is quoted', line);
ok(line.includes('"he said ""hi"""'), 'csv: quotes doubled', line);
ok(line.includes(";'-2+3;"), 'csv: leading minus neutralised', line);
ok(line.includes(';u1 | u2;'), 'csv: arrays joined', line);
ok(line.endsWith(';'), 'csv: null -> empty cell', line);

// ---------------------------------------------------------------- labels
eq(labels.recommendationLabel('warning', 2, 3), 'Warning 2/3', 'label: warning n/N');
eq(labels.recommendationLabel('relocation', 1, null), 'Relocation (cuff out) + Warning 1', 'label: delta warning without max');
eq(labels.recommendationLabel('arrest_authorized'), 'Arrest authorized', 'label: arrest authorized');
eq(labels.recommendationLabel('order_kill'), 'Termination (Kill on Sight)', 'label: KOS');
eq(labels.level('manager') > labels.level('officer') && labels.level('officer') > labels.level('cs') && labels.level('cs') > labels.level('trooper') && labels.level('trooper') > labels.level('read_only') && labels.level('read_only') > labels.level('pending'), true, 'roles ordered like SQL role_level');
eq(labels.level('bogus'), 0, 'unknown role -> 0');
ok(labels.USERNAME_RE.test('Abc_123') && !labels.USERNAME_RE.test('ab') && !labels.USERNAME_RE.test('a'.repeat(21)) && !labels.USERNAME_RE.test('é_abc'), 'username regex mirrors SQL');

// ---------------------------------------------------------------- URL safety
eq(ui.safeUrl('javascript:alert(1)'), '#', 'safeUrl: javascript blocked');
eq(ui.safeUrl('JavaScript:alert(1)'), '#', 'safeUrl: mixed case javascript blocked');
eq(ui.safeUrl('data:text/html,x'), '#', 'safeUrl: data blocked');
eq(ui.safeUrl('//evil.com/x.html'), '#', 'safeUrl: protocol-relative blocked');
eq(ui.safeUrl('http://evil.com'), '#', 'safeUrl: http blocked');
eq(ui.safeUrl('https://ok.com/a'), 'https://ok.com/a', 'safeUrl: https allowed');
eq(ui.safeUrl('log?id=1&x=2'), 'log?id=1&x=2', 'safeUrl: clean internal page allowed');
eq(ui.safeUrl('log.html?id=1&x=2'), 'log.html?id=1&x=2', 'safeUrl: legacy .html page allowed');
eq(ui.safeUrl('/'), '/', 'safeUrl: root (sign-in) allowed');
eq(ui.safeUrl('/?next=logs'), '/?next=logs', 'safeUrl: root with query allowed');
eq(ui.safeUrl('/evil.com'), '#', 'safeUrl: path that looks like a domain blocked');
eq(ui.safeUrl('//evil.com'), '#', 'safeUrl: protocol-relative without path blocked');
eq(ui.safeUrl('logs/../../x'), '#', 'safeUrl: traversal blocked');
eq(ui.safeUrl('assets/logo.webp'), 'assets/logo.webp', 'safeUrl: asset allowed');
eq(ui.link('player', { u: 'a&b=c', empty: '', nil: null }), 'player?u=a%26b%3Dc', 'link: values encoded, empties dropped');

eq(safeNext('/logs?q=x'), 'logs?q=x', 'safeNext: clean internal page kept');
eq(safeNext('logs?q=x'), 'logs?q=x', 'safeNext: relative clean page kept');
eq(safeNext('/logs.html?q=x'), 'logs?q=x', 'safeNext: legacy .html normalised to clean URL');
eq(safeNext('https://evil.com'), 'dashboard', 'safeNext: external URL refused');
eq(safeNext('//evil.com/a.html'), 'dashboard', 'safeNext: protocol-relative refused');
eq(safeNext('index.html'), 'dashboard', 'safeNext: index loops avoided');
eq(safeNext('index'), 'dashboard', 'safeNext: clean index loops avoided');
eq(safeNext('/'), 'dashboard', 'safeNext: root -> dashboard');
eq(safeNext(''), 'dashboard', 'safeNext: empty -> dashboard');
eq(safeNext(null), 'dashboard', 'safeNext: null');
eq(safeNext('/logs?q=x#frag'), 'dashboard', 'safeNext: fragment refused');
eq(safeNext('/logs?q=x y'), 'dashboard', 'safeNext: whitespace refused');

// ---------------------------------------------------------------- error messages
eq(ui.errorMessage({ code: '42501', message: 'new row violates row-level security policy for table "x"' }), 'Action not allowed for your role.', 'error: RLS');
eq(ui.errorMessage({ code: '23505', message: 'duplicate key value violates unique constraint "profiles_roblox_username_lower_key"' }), 'This Roblox username is already used by another account.', 'error: duplicate username');
eq(ui.errorMessage({ code: '23503', message: 'update or delete on table "offenses" violates foreign key constraint "sanction_logs_offense_id_fkey"' }), 'Item still used by other records: it cannot be deleted. Deactivate it instead.', 'error: FK');
eq(ui.errorMessage({ message: 'TypeError: Failed to fetch' }), 'Cannot reach the server. Check your connection.', 'error: network');
eq(ui.errorMessage({ message: 'Invalid login credentials' }), 'Incorrect email, username or password.', 'error: credentials');
eq(ui.errorMessage({ code: '23514', message: 'Only officers can log on behalf of another agent.' }), 'Only officers can log on behalf of another agent.', 'error: trigger message passed through');
eq(ui.errorMessage(null), 'Unknown error.', 'error: null');
eq(ui.errorMessage('plain'), 'plain', 'error: string');
eq(ui.errorMessage({ message: 'new row for relation "sanction_logs" violates check constraint "sanction_logs_evidence_urls_check"' }), 'Invalid evidence: 10 links maximum, https:// only.', 'error: evidence constraint');

console.log(fail ? `${fail}/${total} FAILED` : `ALL ${total} UNIT TESTS PASSED`);
process.exit(fail ? 1 : 0);

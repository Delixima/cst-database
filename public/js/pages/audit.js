// Audit journal (manager only, read-only): filterable, paginated, field diffs.

import { supabase, unwrap } from '../supabase.js';
import { requireAuth } from '../auth.js';
import { boot, renderShell, pageHeader } from '../layout.js';
import {
  h, replace, field, select, input, loadingState, emptyState, errorState, pagination, link, diffView, button, flag,
} from '../ui.js';
import { TABLE_LABELS, AUDIT_ACTIONS, PROCEDURES, ACTIONS, TARGET_TYPES, ORDER_TYPES, STATUSES, ROLES } from '../labels.js';
import { fmtDateTime, dayBoundary } from '../format.js';

const PAGE = 50;

boot(async () => {
  const ctx = await requireAuth({ minLevel: 5 });
  const main = renderShell(ctx, 'audit');

  let profiles = [];
  let offenses = [];
  try {
    [profiles, offenses] = await Promise.all([
      supabase.from('profiles').select('id, roblox_username').order('roblox_username').then(unwrap),
      supabase.from('offenses').select('id, code, name').then(unwrap),
    ]);
  } catch (err) {
    replace(main, errorState(err, () => location.reload()));
    return;
  }
  const profileMap = Object.fromEntries(profiles.map((p) => [p.id, p.roblox_username ?? p.id.slice(0, 8)]));
  const offenseMap = Object.fromEntries(offenses.map((o) => [o.id, `${o.code} — ${o.name}`]));
  const lookups = {
    offense_id: offenseMap, agent_id: profileMap, created_by: profileMap, approved_by: profileMap,
    approval_confirmed_by: profileMap, voided_by: profileMap, reset_by: profileMap,
    procedure: Object.fromEntries(Object.entries(PROCEDURES).map(([k, v]) => [k, v.label])),
    action_taken: ACTIONS, recommended_action: ACTIONS, default_action: ACTIONS, target_type: TARGET_TYPES,
    order_type: ORDER_TYPES, status: STATUSES, role: ROLES,
  };

  const sp = new URLSearchParams(location.search);
  const f = {
    table: TABLE_LABELS[sp.get('table')] ? sp.get('table') : '',
    action: AUDIT_ACTIONS[sp.get('action')] ? sp.get('action') : '',
    user: profileMap[sp.get('user')] ? sp.get('user') : '',
    row: (sp.get('row') ?? '').slice(0, 64),
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    page: Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1),
  };

  const tableSel = select(TABLE_LABELS, { value: f.table, placeholder: 'Toutes' });
  const actionSel = select(AUDIT_ACTIONS, { value: f.action, placeholder: 'Toutes' });
  const userSel = select(profiles.map((p) => ({ value: p.id, label: p.roblox_username ?? p.id.slice(0, 8) })), { value: f.user, placeholder: 'Tous' });
  const rowInput = input({ value: f.row, placeholder: 'Identifiant (uuid)', maxlength: 64, spellcheck: 'false' });
  const fromInput = input({ type: 'date', value: f.from });
  const toInput = input({ type: 'date', value: f.to });

  const form = h('form', { class: 'card' },
    h('div', { class: 'filters' },
      field('Table', tableSel), field('Opération', actionSel), field('Utilisateur', userSel),
      field('Ligne', rowInput), field('Du', fromInput), field('Au', toInput)),
    h('div', { class: 'form-actions' },
      button('Réinitialiser', () => { location.href = 'audit.html'; }, 'ghost'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Filtrer')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(f, {
      table: tableSel.value, action: actionSel.value, user: userSel.value, row: rowInput.value.trim(),
      from: fromInput.value, to: toInput.value, page: 1,
    });
    load();
  });

  const results = h('div');
  replace(main, pageHeader('Journal d’audit', 'Toutes les créations, modifications et suppressions. Lecture seule : ce journal ne peut être ni modifié ni effacé.'), form, results);

  async function load() {
    history.replaceState(null, '', link('audit.html', { ...f, page: f.page > 1 ? f.page : '' }));
    replace(results, loadingState('Chargement du journal…'));
    try {
      let q = supabase.from('audit_log').select('*', { count: 'exact' });
      if (f.table) q = q.eq('table_name', f.table);
      if (f.action) q = q.eq('action', f.action);
      if (f.user) q = q.eq('user_id', f.user);
      if (f.row) q = q.eq('row_id', f.row);
      const from = dayBoundary(f.from);
      const to = dayBoundary(f.to, true);
      if (from) q = q.gte('created_at', from);
      if (to) q = q.lte('created_at', to);
      const start = (f.page - 1) * PAGE;
      const res = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + PAGE - 1);
      if (res.error) throw res.error;
      render(res.data, res.count ?? 0);
    } catch (err) {
      replace(results, errorState(err, load));
    }
  }

  function describe(e) {
    const d = e.new_data ?? e.old_data ?? {};
    switch (e.table_name) {
      case 'sanction_logs': return d.log_number ? `${d.log_number} — ${d.target_username ?? ''}` : '';
      case 'profiles': return d.roblox_username ?? (d.id ?? '').slice(0, 8);
      case 'offenses': return d.code ? `${d.code} — ${d.name}` : '';
      case 'warning_resets': return `${d.target_normalized ?? ''}${d.offense_id ? ' · ' + (offenseMap[d.offense_id] ?? '') : ' · toutes'}`;
      case 'player_aliases': return `${d.alias_normalized ?? ''} → ${d.canonical_normalized ?? ''}`;
      default: return d.name ?? '';
    }
  }

  function targetLink(e) {
    const d = e.new_data ?? e.old_data ?? {};
    if (e.table_name === 'sanction_logs' && e.action !== 'DELETE' && d.id) return h('a', { href: link('log.html', { id: d.id }) }, 'Ouvrir le log');
    if (e.table_name === 'warning_resets' && d.target_normalized) return h('a', { href: link('player.html', { u: d.target_normalized }) }, 'Dossier joueur');
    return null;
  }

  function render(rows, total) {
    if (!rows.length) {
      replace(results, emptyState('Aucune entrée ne correspond.'));
      return;
    }
    const tone = { INSERT: 'info', UPDATE: 'warn', DELETE: 'danger' };
    replace(results,
      h('div', null, rows.map((e) => h('details', { class: 'audit-entry' },
        h('summary', null,
          h('span', { class: 'cell-mono small muted' }, `#${e.id}`),
          h('span', { class: 'nowrap' }, fmtDateTime(e.created_at)),
          flag(AUDIT_ACTIONS[e.action] ?? e.action, tone[e.action]),
          h('strong', null, TABLE_LABELS[e.table_name] ?? e.table_name),
          h('span', null, describe(e)),
          h('span', { class: 'muted' }, 'par ', e.user_id ? (profileMap[e.user_id] ?? e.user_id.slice(0, 8)) : 'système')),
        h('div', { class: 'audit-body' },
          diffView(e.action === 'INSERT' ? null : e.old_data, e.action === 'DELETE' ? null : e.new_data, lookups),
          h('p', { class: 'small', style: { marginTop: '8px' } }, targetLink(e), e.row_id ? h('span', { class: 'muted cell-mono' }, `  ligne ${e.row_id}`) : null))))),
      pagination({ page: f.page, pageSize: PAGE, total, onPage: (p) => { f.page = p; load(); window.scrollTo({ top: 0 }); } }));
  }

  await load();
});

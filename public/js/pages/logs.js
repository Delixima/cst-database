// Logs list: search, filters, sorting, pagination, CSV export.
// Filters live in the query string so a filtered view can be shared.

import { supabase, unwrap } from '../supabase.js';
import { requireAuth } from '../auth.js';
import { boot, renderShell, pageHeader } from '../layout.js';
import {
  h, replace, field, select, input, checkbox, loadingState, emptyState, errorState, table, pagination,
  link, procedureBadge, actionBadge, statusBadge, approvalMark, flag, button, withBusy, toast,
} from '../ui.js';
import { PROCEDURES, ACTIONS, STATUSES, TARGET_TYPES, ORDER_TYPES, recommendationLabel } from '../labels.js';
import { fmtDateTime, fmtJail, escapeLike, dayBoundary, isUuid } from '../format.js';
import { toCsv, downloadText } from '../csv.js';
import { PAGE_SIZE } from '../../config.js';

const SORTS = {
  occurred_at: 'occurred_at',
  log_number: 'log_number',
  target: 'target_normalized',
  offense: 'offense_code',
  action: 'action_taken',
  agent: 'agent_username',
  created_at: 'created_at',
};

boot(async () => {
  const ctx = await requireAuth({ minLevel: 1 });
  const main = renderShell(ctx, 'logs');

  let offenses = [];
  let agents = [];
  try {
    [offenses, agents] = await Promise.all([
      supabase.from('offenses').select('id, code, name, procedure, active').order('procedure').order('code_number').then(unwrap),
      supabase.from('profiles').select('id, roblox_username, role').neq('role', 'pending').order('roblox_username').then(unwrap),
    ]);
  } catch (err) {
    replace(main, errorState(err, () => location.reload()));
    return;
  }

  // ------------------------------------------------------------ filter state (URL)
  const sp = new URLSearchParams(location.search);
  const f = {
    q: sp.get('q') ?? '',
    procedure: sp.get('procedure') ?? '',
    offense: sp.get('offense') ?? '',
    agent: isUuid(sp.get('agent')) ? sp.get('agent') : '',
    action: sp.get('action') ?? '',
    status: sp.get('status') ?? 'valid',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    flag: sp.get('flag') ?? '',
    deleted: sp.get('deleted') === '1' && ctx.perms.manager,
    sort: SORTS[sp.get('sort')] ? sp.get('sort') : 'occurred_at',
    asc: sp.get('asc') === '1',
    page: Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1),
  };

  // ------------------------------------------------------------ controls
  const qInput = input({ type: 'search', value: f.q, placeholder: 'Pseudo ou LOG-2026-00001', maxlength: 40 });
  const procSel = select(Object.fromEntries(Object.entries(PROCEDURES).map(([k, v]) => [k, v.label])), { value: f.procedure, placeholder: 'Toutes' });
  const offenseSel = select(offenses.map((o) => ({ value: o.code, label: `${o.code} — ${o.name}${o.active ? '' : ' (désactivée)'}` })), { value: f.offense, placeholder: 'Toutes' });
  const agentSel = select(agents.map((a) => ({ value: a.id, label: a.roblox_username ?? '(sans pseudo)' })), { value: f.agent, placeholder: 'Tous' });
  const actionSel = select(ACTIONS, { value: f.action, placeholder: 'Toutes' });
  const statusSel = select({ valid: 'Valides', voided: 'Annulés', all: 'Tous' }, { value: f.status });
  const fromInput = input({ type: 'date', value: f.from });
  const toInput = input({ type: 'date', value: f.to });
  const flagSel = select({
    override: 'Écart avec la recommandation',
    approval_pending: 'Approbation ⧭ non confirmée',
    report_missing: 'Rapport non fait',
    reset: 'Remis à zéro (ne compte plus)',
  }, { value: f.flag, placeholder: 'Aucun' });
  const deletedBox = ctx.perms.manager ? checkbox('Inclure les logs supprimés', f.deleted) : null;

  const filtersForm = h('form', { class: 'card no-print', role: 'search' },
    h('div', { class: 'filters' },
      field('Recherche', qInput),
      field('Procédure', procSel),
      field('Infraction', offenseSel),
      field('Agent', agentSel),
      field('Action', actionSel),
      field('Statut', statusSel),
      field('Du', fromInput),
      field('Au', toInput),
      field('Signalement', flagSel),
      deletedBox ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Gérant'), deletedBox) : null),
    h('div', { class: 'form-actions' },
      button('Réinitialiser', () => { location.href = 'logs.html'; }, 'ghost'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Filtrer')));

  filtersForm.addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(f, {
      q: qInput.value.trim(), procedure: procSel.value, offense: offenseSel.value, agent: agentSel.value,
      action: actionSel.value, status: statusSel.value, from: fromInput.value, to: toInput.value,
      flag: flagSel.value, deleted: deletedBox ? deletedBox.input.checked : false, page: 1,
    });
    load();
  });

  const exportBtn = button('Exporter en CSV', null, 'ghost');
  exportBtn.addEventListener('click', () => withBusy(exportBtn, exportCsv));
  const results = h('div', { class: 'stack' });
  const actions = [exportBtn];
  if (ctx.perms.write) actions.unshift(h('a', { class: 'btn btn-primary', href: 'log-new.html' }, '+ Nouveau log'));
  replace(main, pageHeader('Logs des sanctions', 'Recherche dans l’ensemble des sanctions enregistrées.', ...actions), filtersForm, results);

  // ------------------------------------------------------------ query
  const COLUMNS = 'id, log_number, occurred_at, created_at, target_username, target_normalized, target_type, procedure, offense_code, offense_name, offense_requires_cs_approval, offense_report_required, offense_max_warnings, action_taken, warning_number, jail_seconds, agent_username, approver_username, approved_by, approval_confirmed_at, ordered_by, order_type, is_override, recommended_action, recommendation_code, recommended_warning_number, override_reason, report_filed, location, notes, evidence_urls, status, void_reason, counts_for_warnings, deleted_at';

  function buildQuery(columns, { count = false } = {}) {
    let q = supabase.from('sanction_logs_expanded').select(columns, count ? { count: 'exact' } : undefined);
    const term = f.q.trim();
    if (term) {
      if (/^log-/i.test(term)) {
        q = q.ilike('log_number', `%${escapeLike(term.toUpperCase())}%`);
      } else {
        const clean = term.toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (clean) q = q.ilike('target_normalized', `%${escapeLike(clean)}%`);
      }
    }
    if (f.procedure && PROCEDURES[f.procedure]) q = q.eq('procedure', f.procedure);
    if (f.offense) q = q.eq('offense_code', f.offense);
    if (f.agent) q = q.eq('agent_id', f.agent);
    if (f.action && ACTIONS[f.action]) q = q.eq('action_taken', f.action);
    if (f.status === 'valid' || f.status === 'voided') q = q.eq('status', f.status);
    const from = dayBoundary(f.from);
    const to = dayBoundary(f.to, true);
    if (from) q = q.gte('occurred_at', from);
    if (to) q = q.lte('occurred_at', to);
    if (f.flag === 'override') q = q.eq('is_override', true);
    if (f.flag === 'approval_pending') q = q.not('approved_by', 'is', null).is('approval_confirmed_at', null);
    if (f.flag === 'report_missing') q = q.eq('offense_report_required', true).eq('report_filed', false).in('action_taken', ['arrest', 'termination']);
    if (f.flag === 'reset') q = q.eq('counts_for_warnings', false);
    if (!f.deleted) q = q.is('deleted_at', null);
    q = q.order(SORTS[f.sort], { ascending: f.asc, nullsFirst: false });
    if (f.sort !== 'occurred_at') q = q.order('occurred_at', { ascending: false });
    return q;
  }

  function syncUrl() {
    const params = {
      q: f.q, procedure: f.procedure, offense: f.offense, agent: f.agent, action: f.action,
      status: f.status === 'valid' ? '' : f.status, from: f.from, to: f.to, flag: f.flag,
      deleted: f.deleted ? '1' : '', sort: f.sort === 'occurred_at' ? '' : f.sort, asc: f.asc ? '1' : '',
      page: f.page > 1 ? f.page : '',
    };
    history.replaceState(null, '', link('logs.html', params));
  }

  async function load() {
    syncUrl();
    replace(results, loadingState('Recherche…'));
    try {
      const fromIdx = (f.page - 1) * PAGE_SIZE;
      const res = await buildQuery(COLUMNS, { count: true }).range(fromIdx, fromIdx + PAGE_SIZE - 1);
      if (res.error) throw res.error;
      render(res.data, res.count ?? 0);
    } catch (err) {
      replace(results, errorState(err, load));
    }
  }

  function flagsFor(r) {
    return [
      r.is_override ? flag('Écart', 'warn', `Recommandé : ${recommendationLabel(r.recommendation_code, r.recommended_warning_number, r.offense_max_warnings)}`) : null,
      r.approved_by && !r.approval_confirmed_at ? flag('⧭ à confirmer', 'warn') : null,
      r.offense_report_required && !r.report_filed && ['arrest', 'termination'].includes(r.action_taken) ? flag('Rapport', 'danger', 'Rapport obligatoire non fait') : null,
      !r.counts_for_warnings ? flag('RAZ', 'muted', 'Warnings remis à zéro : ne compte plus') : null,
      r.order_type !== 'none' ? flag(r.order_type === 'hicom_isb_order' ? 'HICOM/ISB' : r.order_type === 'kill_on_sight' ? 'KOS' : 'AOS', 'info', `Ordre de ${r.ordered_by ?? '—'}`) : null,
    ];
  }

  function render(rows, total) {
    if (!rows.length) {
      replace(results, emptyState('Aucun log ne correspond à ces critères.'));
      return;
    }
    const onSort = (col) => {
      if (f.sort === col) f.asc = !f.asc;
      else { f.sort = col; f.asc = col === 'target' || col === 'offense' || col === 'agent'; }
      f.page = 1;
      load();
    };
    replace(results,
      table([
        { label: 'N°', sort: 'log_number', className: 'cell-mono nowrap', render: (r) => r.log_number },
        { label: 'Date des faits', sort: 'occurred_at', className: 'nowrap', render: (r) => fmtDateTime(r.occurred_at) },
        { label: 'Cible', sort: 'target', className: 'cell-strong', render: (r) => h('a', { href: link('player.html', { u: r.target_normalized }) }, r.target_username) },
        { label: 'Procédure', render: (r) => procedureBadge(r.procedure) },
        { label: 'Infraction', sort: 'offense', render: (r) => [h('span', { class: 'cell-mono', title: r.offense_name }, r.offense_code), r.offense_requires_cs_approval ? approvalMark() : null] },
        { label: 'Action', sort: 'action', render: (r) => actionBadge(r.action_taken, r.warning_number, r.offense_max_warnings) },
        { label: 'Jail', className: 'nowrap small', render: (r) => (r.jail_seconds ? `${r.jail_seconds} s` : '—') },
        { label: 'Agent', sort: 'agent', render: (r) => r.agent_username ?? '—' },
        { label: 'Statut', render: (r) => statusBadge(r.status, r.deleted_at) },
        { label: 'Signalements', render: flagsFor },
      ], rows, {
        sort: { column: f.sort, ascending: f.asc },
        onSort,
        onRowClick: (r) => { location.href = link('log.html', { id: r.id }); },
        rowClass: (r) => (r.deleted_at ? 'row-deleted' : r.status === 'voided' ? 'row-voided' : (!r.counts_for_warnings ? 'row-reset' : '')),
      }),
      pagination({ page: f.page, pageSize: PAGE_SIZE, total, onPage: (p) => { f.page = p; load(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }));
  }

  async function exportCsv() {
    const all = [];
    const chunk = 1000;
    for (let offset = 0; offset < 50000; offset += chunk) {
      const rows = unwrap(await buildQuery(COLUMNS).range(offset, offset + chunk - 1));
      all.push(...rows);
      if (rows.length < chunk) break;
    }
    if (!all.length) {
      toast('Rien à exporter avec ces filtres.', 'warn');
      return;
    }
    const csv = toCsv(all, [
      { label: 'Numéro', get: (r) => r.log_number },
      { label: 'Date des faits', get: (r) => fmtDateTime(r.occurred_at) },
      { label: 'Date ISO', get: (r) => r.occurred_at },
      { label: 'Cible', get: (r) => r.target_username },
      { label: 'Dossier joueur', get: (r) => r.target_normalized },
      { label: 'Type de cible', get: (r) => TARGET_TYPES[r.target_type] },
      { label: 'Procédure', get: (r) => PROCEDURES[r.procedure]?.label },
      { label: 'Code', get: (r) => r.offense_code },
      { label: 'Infraction', get: (r) => r.offense_name },
      { label: 'Action prise', get: (r) => ACTIONS[r.action_taken] },
      { label: 'N° Warning', get: (r) => r.warning_number },
      { label: 'Jail', get: (r) => fmtJail(r.jail_seconds) },
      { label: 'Recommandation', get: (r) => recommendationLabel(r.recommendation_code, r.recommended_warning_number, r.offense_max_warnings) },
      { label: 'Écart', get: (r) => (r.is_override ? 'Oui' : 'Non') },
      { label: 'Justification écart', get: (r) => r.override_reason },
      { label: 'Agent', get: (r) => r.agent_username },
      { label: 'Approbateur', get: (r) => r.approver_username },
      { label: 'Approbation confirmée', get: (r) => (r.approved_by ? (r.approval_confirmed_at ? 'Oui' : 'Non') : '') },
      { label: 'Type d’ordre', get: (r) => ORDER_TYPES[r.order_type] },
      { label: 'Ordre donné par', get: (r) => r.ordered_by },
      { label: 'Rapport fait', get: (r) => (r.report_filed ? 'Oui' : 'Non') },
      { label: 'Lieu', get: (r) => r.location },
      { label: 'Notes', get: (r) => r.notes },
      { label: 'Preuves', get: (r) => r.evidence_urls },
      { label: 'Statut', get: (r) => (r.deleted_at ? 'Supprimé' : STATUSES[r.status]) },
      { label: 'Motif annulation', get: (r) => r.void_reason },
      { label: 'Compte pour les Warnings', get: (r) => (r.counts_for_warnings ? 'Oui' : 'Non') },
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`cst-logs-${stamp}.csv`, csv);
    toast(`${all.length} log(s) exporté(s).`, 'success');
  }

  await load();
});

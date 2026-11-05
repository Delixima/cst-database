// Dashboard: daily/weekly figures, action split, top offenses, agent activity,
// latest logs, logs awaiting ⧭ approval confirmation.

import { supabase, unwrap } from '../supabase.js';
import { requireAuth } from '../auth.js';
import { boot, renderShell, pageHeader } from '../layout.js';
import {
  h, replace, card, loadingState, emptyState, errorState, table, barList, link,
  procedureBadge, actionBadge, approvalMark, flag, button, withBusy, toast,
} from '../ui.js';
import { ACTIONS, ACTION_KEYS, actionTone } from '../labels.js';
import { fmtDateTime, fmtRelative, fmtNumber, browserTimezone } from '../format.js';

boot(async () => {
  const ctx = await requireAuth({ minLevel: 1 });
  const main = renderShell(ctx, 'dashboard');

  const actions = ctx.perms.write ? [h('a', { class: 'btn btn-primary', href: 'log-new.html' }, '+ Nouveau log')] : [];
  const header = pageHeader('Tableau de bord', `Bienvenue, ${ctx.profile.roblox_username ?? 'trooper'}.`, ...actions);
  const body = h('div', { class: 'stack' }, loadingState('Chargement des statistiques…'));
  replace(main, header, body);

  async function load() {
    replace(body, loadingState('Chargement des statistiques…'));
    try {
      const [stats, recent, pending] = await Promise.all([
        supabase.rpc('dashboard_stats', { p_tz: browserTimezone() }).then(unwrap),
        supabase.from('sanction_logs_expanded')
          .select('id, log_number, occurred_at, target_username, target_normalized, procedure, offense_code, offense_requires_cs_approval, action_taken, warning_number, offense_max_warnings, agent_username, status, is_override')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(10)
          .then(unwrap),
        ctx.perms.cs
          ? supabase.from('sanction_logs_expanded')
            .select('id, log_number, occurred_at, target_username, offense_code, offense_name, agent_username, approver_username, procedure')
            .is('deleted_at', null)
            .eq('status', 'valid')
            .not('approved_by', 'is', null)
            .is('approval_confirmed_at', null)
            .order('created_at', { ascending: false })
            .limit(20)
            .then(unwrap)
          : Promise.resolve(null),
      ]);
      render(stats, recent, pending);
    } catch (err) {
      replace(body, errorState(err, load));
    }
  }

  function stat(label, value, sub, tone) {
    return h('div', { class: 'card' },
      h('div', { class: ['stat', tone && `tone-${tone}`] },
        h('span', { class: 'stat-label' }, label),
        h('span', { class: 'stat-value' }, fmtNumber(value)),
        sub ? h('span', { class: 'stat-sub' }, sub) : null));
  }

  function actionSplit(map) {
    const items = ACTION_KEYS
      .map((a) => ({ label: ACTIONS[a], value: Number(map?.[a] ?? 0), tone: actionTone(a) }))
      .filter((i) => i.value > 0);
    return barList(items, { empty: 'Aucune sanction sur la période.' });
  }

  function render(stats, recent, pending) {
    const week = stats.actions_week ?? {};
    const month = stats.actions_month ?? {};

    const statRow = h('div', { class: 'grid grid-5' },
      stat('Logs aujourd’hui', stats.today, null, 'cyan'),
      stat('Cette semaine', stats.week, `${fmtNumber(week.arrest ?? 0)} arrestations · ${fmtNumber(week.warning ?? 0)} warnings`),
      stat('Ce mois', stats.month, `${fmtNumber(month.termination ?? 0)} terminaisons`),
      ctx.perms.cs
        ? stat('Approbations ⧭ à confirmer', stats.pending_approvals ?? 0, 'Arrestations ⧭ non confirmées', (stats.pending_approvals ?? 0) > 0 ? 'warn' : null)
        : stat('Arrestations (mois)', month.arrest ?? 0, null, 'danger'),
      stat('Rapports en attente', stats.reports_pending, 'Rapport obligatoire non marqué fait', stats.reports_pending > 0 ? 'danger' : null));

    const splitRow = h('div', { class: 'grid grid-2' },
      card('Arrestations · Warnings · Terminaisons — semaine', actionSplit(week)),
      card('Répartition — mois', actionSplit(month)));

    const topOffenses = (stats.top_offenses_month ?? []).map((o) => ({
      prefix: procedureBadge(o.procedure),
      label: `${o.code} — ${o.name}`,
      value: o.total,
      tone: 'danger',
      href: link('logs.html', { offense: o.code, from: monthStartValue() }),
    }));

    const agents = stats.agents_month ?? [];
    const agentTable = agents.length
      ? table([
        { label: 'Agent', render: (r) => h('a', { href: link('logs.html', { agent: r.id, from: monthStartValue() }) }, r.roblox_username ?? '—') },
        { label: 'Logs', className: 'right cell-mono', render: (r) => String(r.total) },
        { label: 'Arr.', className: 'right cell-mono', render: (r) => String(r.arrests) },
        { label: 'Warn.', className: 'right cell-mono', render: (r) => String(r.warnings) },
        { label: 'Term.', className: 'right cell-mono', render: (r) => String(r.terminations) },
      ], agents)
      : emptyState('Aucune activité ce mois-ci.');

    const midRow = h('div', { class: 'grid grid-2' },
      card('Top infractions du mois', barList(topOffenses, { empty: 'Aucune infraction ce mois-ci.' })),
      card('Activité par agent — mois', agentTable));

    const recentCard = card(null,
      h('h2', { class: 'card-title' }, 'Derniers logs', h('a', { href: 'logs.html' }, 'Tout voir →')),
      recent.length
        ? table([
          { label: 'N°', className: 'cell-mono nowrap', render: (r) => r.log_number },
          { label: 'Date', className: 'nowrap', render: (r) => h('span', { title: fmtDateTime(r.occurred_at) }, fmtRelative(r.occurred_at)) },
          { label: 'Cible', className: 'cell-strong', render: (r) => h('a', { href: link('player.html', { u: r.target_normalized }) }, r.target_username) },
          { label: 'Procédure', render: (r) => procedureBadge(r.procedure) },
          { label: 'Infraction', className: 'cell-mono', render: (r) => [r.offense_code, r.offense_requires_cs_approval ? approvalMark() : null] },
          { label: 'Action', render: (r) => [actionBadge(r.action_taken, r.warning_number, r.offense_max_warnings), r.is_override ? flag('Écart', 'warn') : null] },
          { label: 'Agent', render: (r) => r.agent_username ?? '—' },
        ], recent, {
          onRowClick: (r) => { location.href = link('log.html', { id: r.id }); },
          rowClass: (r) => (r.status === 'voided' ? 'row-voided' : ''),
        })
        : emptyState('Aucun log pour le moment.', ctx.perms.write ? h('a', { class: 'btn btn-primary', href: 'log-new.html' }, 'Créer le premier log') : null));

    const blocks = [statRow];

    if (pending) {
      const pendingCard = card(`Logs ⧭ en attente de confirmation d’approbation (${pending.length})`,
        pending.length
          ? table([
            { label: 'N°', className: 'cell-mono nowrap', render: (r) => h('a', { href: link('log.html', { id: r.id }) }, r.log_number) },
            { label: 'Date', className: 'nowrap', render: (r) => fmtDateTime(r.occurred_at) },
            { label: 'Cible', className: 'cell-strong', render: (r) => r.target_username },
            { label: 'Infraction', render: (r) => [procedureBadge(r.procedure), ' ', h('span', { class: 'cell-mono' }, r.offense_code), approvalMark()] },
            { label: 'Agent', render: (r) => r.agent_username ?? '—' },
            { label: 'Approbateur déclaré', render: (r) => r.approver_username ?? '—' },
            {
              label: '', className: 'right', render: (r) => {
                const b = button('Confirmer', null, 'primary btn-sm');
                b.addEventListener('click', () => withBusy(b, async () => {
                  unwrap(await supabase.rpc('confirm_approval', { p_log_id: r.id }));
                  toast(`Approbation du ${r.log_number} confirmée.`, 'success');
                  await load();
                }));
                return b;
              },
            },
          ], pending)
          : emptyState('Aucune approbation en attente.'));
      blocks.push(pendingCard);
    }

    blocks.push(splitRow, midRow, recentCard);
    replace(body, ...blocks);
  }

  function monthStartValue() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }

  await load();
});

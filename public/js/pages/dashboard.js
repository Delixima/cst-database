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

  const actions = ctx.perms.write ? [h('a', { class: 'btn btn-primary', href: 'log-new.html' }, '+ New log')] : [];
  const header = pageHeader('Dashboard', `Welcome, ${ctx.profile.roblox_username ?? 'trooper'}.`, ...actions);
  const body = h('div', { class: 'stack' }, loadingState('Loading statistics…'));
  replace(main, header, body);

  async function load() {
    replace(body, loadingState('Loading statistics…'));
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
            .eq('action_taken', 'arrest')
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
    return barList(items, { empty: 'No sanctions in this period.' });
  }

  function render(stats, recent, pending) {
    const week = stats.actions_week ?? {};
    const month = stats.actions_month ?? {};

    const statRow = h('div', { class: 'grid grid-5' },
      stat('Logs today', stats.today, null, 'cyan'),
      stat('This week', stats.week, `${fmtNumber(week.arrest ?? 0)} arrests · ${fmtNumber(week.warning ?? 0)} warnings`),
      stat('This month', stats.month, `${fmtNumber(month.termination ?? 0)} terminations`),
      ctx.perms.cs
        ? stat('⧭ approvals to confirm', stats.pending_approvals ?? 0, 'Unconfirmed ⧭ arrests', (stats.pending_approvals ?? 0) > 0 ? 'warn' : null)
        : stat('Arrests (month)', month.arrest ?? 0, null, 'danger'),
      stat('Pending reports', stats.reports_pending, 'Required report not marked as filed', stats.reports_pending > 0 ? 'danger' : null));

    const splitRow = h('div', { class: 'grid grid-2' },
      card('Arrests · Warnings · Terminations — week', actionSplit(week)),
      card('Breakdown — month', actionSplit(month)));

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
      : emptyState('No activity this month.');

    const midRow = h('div', { class: 'grid grid-2' },
      card('Top offenses this month', barList(topOffenses, { empty: 'No offenses this month.' })),
      card('Activity by agent — month', agentTable));

    const recentCard = card(null,
      h('h2', { class: 'card-title' }, 'Latest logs', h('a', { href: 'logs.html' }, 'View all →')),
      recent.length
        ? table([
          { label: 'No.', className: 'cell-mono nowrap', render: (r) => r.log_number },
          { label: 'Date', className: 'nowrap', render: (r) => h('span', { title: fmtDateTime(r.occurred_at) }, fmtRelative(r.occurred_at)) },
          { label: 'Target', className: 'cell-strong', render: (r) => h('a', { href: link('player.html', { u: r.target_normalized }) }, r.target_username) },
          { label: 'Procedure', render: (r) => procedureBadge(r.procedure) },
          { label: 'Offense', className: 'cell-mono', render: (r) => [r.offense_code, r.offense_requires_cs_approval ? approvalMark() : null] },
          { label: 'Action', render: (r) => [actionBadge(r.action_taken, r.warning_number, r.offense_max_warnings), r.is_override ? flag('Override', 'warn') : null] },
          { label: 'Agent', render: (r) => r.agent_username ?? '—' },
        ], recent, {
          onRowClick: (r) => { location.href = link('log.html', { id: r.id }); },
          rowClass: (r) => (r.status === 'voided' ? 'row-voided' : ''),
        })
        : emptyState('No logs yet.', ctx.perms.write ? h('a', { class: 'btn btn-primary', href: 'log-new.html' }, 'Create the first log') : null));

    const blocks = [statRow];

    if (pending) {
      const pendingCard = card(`⧭ logs awaiting approval confirmation (${pending.length})`,
        pending.length
          ? table([
            { label: 'No.', className: 'cell-mono nowrap', render: (r) => h('a', { href: link('log.html', { id: r.id }) }, r.log_number) },
            { label: 'Date', className: 'nowrap', render: (r) => fmtDateTime(r.occurred_at) },
            { label: 'Target', className: 'cell-strong', render: (r) => r.target_username },
            { label: 'Offense', render: (r) => [procedureBadge(r.procedure), ' ', h('span', { class: 'cell-mono' }, r.offense_code), approvalMark()] },
            { label: 'Agent', render: (r) => r.agent_username ?? '—' },
            { label: 'Declared approver', render: (r) => r.approver_username ?? '—' },
            {
              label: '', className: 'right', render: (r) => {
                const b = button('Confirm', null, 'primary btn-sm');
                b.addEventListener('click', () => withBusy(b, async () => {
                  unwrap(await supabase.rpc('confirm_approval', { p_log_id: r.id }));
                  toast(`Approval of ${r.log_number} confirmed.`, 'success');
                  await load();
                }));
                return b;
              },
            },
          ], pending)
          : emptyState('No pending approvals.'));
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

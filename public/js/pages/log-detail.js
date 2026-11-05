// Log detail: all fields, evidence, modification history (audit), void/restore,
// approval confirmation, soft/hard delete (manager), clean print.

import { supabase, unwrap } from '../supabase.js';
import { requireAuth, canEditLog } from '../auth.js';
import { boot, renderShell, pageHeader } from '../layout.js';
import {
  h, replace, card, loadingState, errorState, emptyState, link, definitionList, evidenceView, diffView,
  procedureBadge, actionBadge, statusBadge, approvalMark, flag, button, withBusy, toast, confirmDialog,
} from '../ui.js';
import {
  PROCEDURES, ACTIONS, TARGET_TYPES, ORDER_TYPES, AUDIT_ACTIONS, recommendationLabel, APPROVAL_MARK,
  STATUSES,
} from '../labels.js';
import { qs, isUuid, fmtDateTime, fmtLong, fmtJail } from '../format.js';

boot(async () => {
  const ctx = await requireAuth({ minLevel: 1 });
  const main = renderShell(ctx, 'logs');
  const id = qs('id');
  if (!isUuid(id)) {
    replace(main, errorState('Invalid log ID.'));
    return;
  }

  const saved = qs('saved');
  if (saved) {
    toast(saved === 'created' ? 'Log saved.' : 'Changes saved.', 'success');
    history.replaceState(null, '', link('log.html', { id }));
  }

  let lookups = null;

  async function load() {
    replace(main, loadingState('Loading the log…'));
    try {
      const log = unwrap(await supabase.from('sanction_logs_expanded').select('*').eq('id', id).maybeSingle());
      if (!log) {
        replace(main, errorState('Log not found, deleted or not accessible.'),
          h('p', null, h('a', { href: 'logs.html' }, '← Back to logs')));
        return;
      }
      const [history, offenses, profiles] = await Promise.all([
        supabase.rpc('get_log_history', { p_log_id: id }).then(unwrap),
        lookups ? null : supabase.from('offenses').select('id, code, name').then(unwrap),
        lookups ? null : supabase.from('profiles').select('id, roblox_username').then(unwrap),
      ]);
      if (!lookups) {
        const offenseMap = Object.fromEntries(offenses.map((o) => [o.id, `${o.code} — ${o.name}`]));
        const profileMap = Object.fromEntries(profiles.map((p) => [p.id, p.roblox_username ?? p.id]));
        lookups = {
          offense_id: offenseMap,
          agent_id: profileMap, created_by: profileMap, approved_by: profileMap,
          approval_confirmed_by: profileMap, voided_by: profileMap,
          procedure: Object.fromEntries(Object.entries(PROCEDURES).map(([k, v]) => [k, v.label])),
          action_taken: ACTIONS, recommended_action: ACTIONS, target_type: TARGET_TYPES,
          order_type: ORDER_TYPES, status: STATUSES,
        };
      }
      render(log, history);
    } catch (err) {
      replace(main, errorState(err, load));
    }
  }

  function render(log, history) {
    const editable = canEditLog(ctx, log);
    const deleted = Boolean(log.deleted_at);
    const pendingApproval = log.approved_by && !log.approval_confirmed_at;
    const reportMissing = log.offense_report_required && !log.report_filed && ['arrest', 'termination'].includes(log.action_taken);

    // ----- actions
    const actions = [];
    actions.push(button('Print', () => window.print(), 'ghost'));
    if (editable && !deleted) actions.push(h('a', { class: 'btn btn-primary', href: link('log-new.html', { edit: log.id }) }, 'Edit'));
    if (editable && !deleted && reportMissing) {
      const b = button('Mark report as filed', null, 'ghost');
      b.addEventListener('click', () => withBusy(b, async () => {
        const rows = unwrap(await supabase.from('sanction_logs').update({ report_filed: true }).eq('id', log.id).select('id'));
        if (!rows.length) throw new Error('Update refused.');
        toast('Report marked as filed.', 'success');
        await load();
      }));
      actions.push(b);
    }
    if (ctx.perms.cs && pendingApproval && !deleted && log.status === 'valid') {
      const b = button(`Confirm approval ${APPROVAL_MARK}`, null, 'primary');
      b.addEventListener('click', () => withBusy(b, async () => {
        unwrap(await supabase.rpc('confirm_approval', { p_log_id: log.id }));
        toast('Approval confirmed.', 'success');
        await load();
      }));
      actions.push(b);
    }
    if (ctx.perms.officer && !deleted) {
      if (log.status === 'valid') {
        actions.push(button('Void log', async () => {
          const r = await confirmDialog({
            title: `Void ${log.log_number}`,
            message: 'The log stays visible (struck through) but no longer counts in statistics or warnings.',
            confirmLabel: 'Void log', danger: true,
            reason: { label: 'Void reason', minLength: 3, maxLength: 500, placeholder: 'e.g. Wrong target, duplicate…' },
          });
          if (!r) return;
          await withBusy(null, async () => {
            const rows = unwrap(await supabase.from('sanction_logs').update({ status: 'voided', void_reason: r.value }).eq('id', log.id).select('id'));
            if (!rows.length) throw new Error('Void refused.');
            toast('Log voided.', 'success');
            await load();
          });
        }, 'danger'));
      } else {
        actions.push(button('Restore log', async () => {
          const r = await confirmDialog({ title: `Restore ${log.log_number}`, message: 'The log will become valid again.', confirmLabel: 'Restore' });
          if (!r) return;
          await withBusy(null, async () => {
            unwrap(await supabase.from('sanction_logs').update({ status: 'valid' }).eq('id', log.id).select('id'));
            toast('Log restored.', 'success');
            await load();
          });
        }, 'ghost'));
      }
    }
    if (ctx.perms.manager) {
      if (!deleted) {
        actions.push(button('Delete', async () => {
          const r = await confirmDialog({
            title: `Delete ${log.log_number}`,
            message: 'Soft delete: the log disappears for everyone except the manager, who can restore it.',
            confirmLabel: 'Delete', danger: true,
          });
          if (!r) return;
          await withBusy(null, async () => {
            unwrap(await supabase.from('sanction_logs').update({ deleted_at: new Date().toISOString() }).eq('id', log.id).select('id'));
            toast('Log deleted (restorable).', 'success');
            await load();
          });
        }, 'danger'));
      } else {
        actions.push(button('Undelete', async () => {
          await withBusy(null, async () => {
            unwrap(await supabase.from('sanction_logs').update({ deleted_at: null }).eq('id', log.id).select('id'));
            toast('Log undeleted.', 'success');
            await load();
          });
        }, 'primary'));
        actions.push(button('Delete permanently', async () => {
          const r = await confirmDialog({
            title: `Permanently delete ${log.log_number}`,
            message: 'This cannot be undone. A copy remains only in the audit log.',
            confirmLabel: 'Delete permanently', danger: true, typeToConfirm: log.log_number,
          });
          if (!r) return;
          await withBusy(null, async () => {
            const rows = unwrap(await supabase.from('sanction_logs').delete().eq('id', log.id).select('id'));
            if (!rows.length) throw new Error('Delete refused.');
            toast('Log permanently deleted.', 'success');
            location.href = 'logs.html';
          });
        }, 'danger'));
      }
    }

    // ----- hero
    const recLabel = recommendationLabel(log.recommendation_code, log.recommended_warning_number, log.offense_max_warnings);
    const hero = card(null,
      h('div', { class: 'log-hero' },
        h('div', null,
          h('div', { class: 'log-number' }, log.log_number),
          h('div', { class: 'log-badges' },
            procedureBadge(log.procedure),
            actionBadge(log.action_taken, log.warning_number, log.offense_max_warnings),
            statusBadge(log.status, log.deleted_at),
            log.is_override ? flag('Override of the recommendation', 'warn') : null,
            pendingApproval ? flag(`${APPROVAL_MARK} Approval not confirmed`, 'warn') : null,
            reportMissing ? flag('Required report not filed', 'danger') : null,
            !log.counts_for_warnings ? flag('Warnings reset', 'muted') : null)),
        h('div', { class: 'right' },
          h('div', { class: 'muted small' }, 'Incident date'),
          h('div', { class: 'cell-strong' }, fmtLong(log.occurred_at)))));

    const notices = [];
    if (deleted) notices.push(h('div', { class: 'notice notice-danger' }, `Log deleted on ${fmtDateTime(log.deleted_at)}. Visible to the manager only.`));
    if (log.status === 'voided') {
      notices.push(h('div', { class: 'notice notice-warn' },
        `Log voided on ${fmtDateTime(log.voided_at)} by ${log.voided_by_username ?? '—'}. Reason: ${log.void_reason}`));
    }
    if (log.is_override) {
      notices.push(h('div', { class: 'notice notice-warn' },
        `Override: the recommendation was "${recLabel}", the agent chose "${ACTIONS[log.action_taken]}".` +
        (log.override_reason ? ` Justification: ${log.override_reason}` : (log.order_type !== 'none' ? ` Justified by the order (${ORDER_TYPES[log.order_type]}).` : ''))));
    }

    const sanction = card('Sanction', definitionList([
      ['Target', h('a', { href: link('player.html', { u: log.target_normalized }) }, log.target_username)],
      log.target_normalized !== log.target_username.toLowerCase() ? ['Player record', log.target_normalized] : null,
      ['Target type', TARGET_TYPES[log.target_type]],
      ['Procedure', [procedureBadge(log.procedure), ' ', PROCEDURES[log.procedure]?.desc]],
      ['Offense', [h('span', { class: 'cell-mono' }, log.offense_code), ' — ', log.offense_name, log.offense_requires_cs_approval ? approvalMark() : null]],
      ['Action taken', actionBadge(log.action_taken, log.warning_number, log.offense_max_warnings)],
      ['Jail', fmtJail(log.jail_seconds)],
      ['Prior warnings', log.offense_max_warnings === null ? `${log.prior_warnings} (no maximum)` : `${log.prior_warnings} / ${log.offense_max_warnings}`],
      ['Recommendation', recLabel],
      ['Location', log.location],
    ]));

    const people = card('People involved', definitionList([
      ['Agent', [log.agent_username ?? '—', log.agent_service_number ? h('span', { class: 'muted' }, ` · ${log.agent_service_number}`) : null]],
      ['Entered by', log.created_by_username],
      ['Approver', log.approver_username ?? (log.offense_requires_cs_approval ? 'None' : '—')],
      log.approved_by ? ['Approval confirmed', log.approval_confirmed_at ? `${log.approval_confirmed_by_username ?? '—'}, on ${fmtDateTime(log.approval_confirmed_at)}` : 'Not confirmed'] : null,
      ['Order', ORDER_TYPES[log.order_type]],
      log.order_type !== 'none' ? ['Ordered by', log.ordered_by] : null,
      ['Report filed', log.report_filed ? 'Yes' : (log.offense_report_required ? 'No (required)' : 'No')],
      ['Created at', fmtDateTime(log.created_at)],
      ['Updated at', fmtDateTime(log.updated_at)],
    ]));

    const notes = card('Notes', log.notes ? h('p', { style: { whiteSpace: 'pre-line' } }, log.notes) : h('p', { class: 'muted' }, 'No notes.'));
    const evidence = card(`Evidence (${log.evidence_urls?.length ?? 0})`, evidenceView(log.evidence_urls));

    const historyCard = card('Change history',
      history.length
        ? h('ol', { class: 'timeline' }, history.map((e) => h('li', { class: `timeline-item t-${e.action}` },
          h('div', { class: 'timeline-head' },
            h('strong', null, AUDIT_ACTIONS[e.action] ?? e.action),
            h('span', { class: 'muted' }, fmtDateTime(e.created_at)),
            h('span', null, 'by ', e.user_username ?? 'system')),
          e.action === 'INSERT' ? h('p', { class: 'muted small' }, 'Log created.') : diffView(e.old_data, e.new_data, lookups))))
        : emptyState('No history.'));

    replace(main,
      h('p', { class: 'no-print' }, h('a', { href: 'logs.html' }, '← Logs')),
      pageHeader(`Log ${log.log_number}`, `${log.offense_code} — ${log.offense_name}`, ...actions),
      h('div', { class: 'print-only' }, h('p', null, `Coruscant Shock Troopers — printed on ${fmtDateTime(new Date().toISOString())}`)),
      h('div', { class: 'stack' },
        hero, notices,
        h('div', { class: 'grid grid-2' }, sanction, people),
        notes, evidence, historyCard));
  }

  await load();
});

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
    replace(main, errorState('Identifiant de log invalide.'));
    return;
  }

  const saved = qs('saved');
  if (saved) {
    toast(saved === 'created' ? 'Log enregistré.' : 'Modifications enregistrées.', 'success');
    history.replaceState(null, '', link('log.html', { id }));
  }

  let lookups = null;

  async function load() {
    replace(main, loadingState('Chargement du log…'));
    try {
      const log = unwrap(await supabase.from('sanction_logs_expanded').select('*').eq('id', id).maybeSingle());
      if (!log) {
        replace(main, errorState('Log introuvable, supprimé ou inaccessible.'),
          h('p', null, h('a', { href: 'logs.html' }, '← Retour aux logs')));
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
    actions.push(button('Imprimer', () => window.print(), 'ghost'));
    if (editable && !deleted) actions.push(h('a', { class: 'btn btn-primary', href: link('log-new.html', { edit: log.id }) }, 'Modifier'));
    if (editable && !deleted && reportMissing) {
      const b = button('Marquer le rapport fait', null, 'ghost');
      b.addEventListener('click', () => withBusy(b, async () => {
        const rows = unwrap(await supabase.from('sanction_logs').update({ report_filed: true }).eq('id', log.id).select('id'));
        if (!rows.length) throw new Error('Modification refusée.');
        toast('Rapport marqué comme fait.', 'success');
        await load();
      }));
      actions.push(b);
    }
    if (ctx.perms.cs && pendingApproval && !deleted && log.status === 'valid') {
      const b = button(`Confirmer l’approbation ${APPROVAL_MARK}`, null, 'primary');
      b.addEventListener('click', () => withBusy(b, async () => {
        unwrap(await supabase.rpc('confirm_approval', { p_log_id: log.id }));
        toast('Approbation confirmée.', 'success');
        await load();
      }));
      actions.push(b);
    }
    if (ctx.perms.officer && !deleted) {
      if (log.status === 'valid') {
        actions.push(button('Annuler le log', async () => {
          const r = await confirmDialog({
            title: `Annuler ${log.log_number}`,
            message: 'Le log restera visible (barré) mais ne comptera plus dans les statistiques ni les Warnings.',
            confirmLabel: 'Annuler le log', danger: true,
            reason: { label: 'Motif d’annulation', minLength: 3, maxLength: 500, placeholder: 'ex. Erreur de cible, doublon…' },
          });
          if (!r) return;
          await withBusy(null, async () => {
            const rows = unwrap(await supabase.from('sanction_logs').update({ status: 'voided', void_reason: r.value }).eq('id', log.id).select('id'));
            if (!rows.length) throw new Error('Annulation refusée.');
            toast('Log annulé.', 'success');
            await load();
          });
        }, 'danger'));
      } else {
        actions.push(button('Rétablir le log', async () => {
          const r = await confirmDialog({ title: `Rétablir ${log.log_number}`, message: 'Le log redeviendra valide.', confirmLabel: 'Rétablir' });
          if (!r) return;
          await withBusy(null, async () => {
            unwrap(await supabase.from('sanction_logs').update({ status: 'valid' }).eq('id', log.id).select('id'));
            toast('Log rétabli.', 'success');
            await load();
          });
        }, 'ghost'));
      }
    }
    if (ctx.perms.manager) {
      if (!deleted) {
        actions.push(button('Supprimer', async () => {
          const r = await confirmDialog({
            title: `Supprimer ${log.log_number}`,
            message: 'Suppression douce : le log disparaît pour tous sauf le gérant, qui peut le restaurer.',
            confirmLabel: 'Supprimer', danger: true,
          });
          if (!r) return;
          await withBusy(null, async () => {
            unwrap(await supabase.from('sanction_logs').update({ deleted_at: new Date().toISOString() }).eq('id', log.id).select('id'));
            toast('Log supprimé (restaurable).', 'success');
            await load();
          });
        }, 'danger'));
      } else {
        actions.push(button('Restaurer', async () => {
          await withBusy(null, async () => {
            unwrap(await supabase.from('sanction_logs').update({ deleted_at: null }).eq('id', log.id).select('id'));
            toast('Log restauré.', 'success');
            await load();
          });
        }, 'primary'));
        actions.push(button('Supprimer définitivement', async () => {
          const r = await confirmDialog({
            title: `Suppression définitive de ${log.log_number}`,
            message: 'Action irréversible. Une copie reste uniquement dans le journal d’audit.',
            confirmLabel: 'Supprimer définitivement', danger: true, typeToConfirm: log.log_number,
          });
          if (!r) return;
          await withBusy(null, async () => {
            const rows = unwrap(await supabase.from('sanction_logs').delete().eq('id', log.id).select('id'));
            if (!rows.length) throw new Error('Suppression refusée.');
            toast('Log supprimé définitivement.', 'success');
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
            log.is_override ? flag('Écart avec la recommandation', 'warn') : null,
            pendingApproval ? flag(`${APPROVAL_MARK} Approbation non confirmée`, 'warn') : null,
            reportMissing ? flag('Rapport obligatoire non fait', 'danger') : null,
            !log.counts_for_warnings ? flag('Warnings remis à zéro', 'muted') : null)),
        h('div', { class: 'right' },
          h('div', { class: 'muted small' }, 'Date des faits'),
          h('div', { class: 'cell-strong' }, fmtLong(log.occurred_at)))));

    const notices = [];
    if (deleted) notices.push(h('div', { class: 'notice notice-danger' }, `Log supprimé le ${fmtDateTime(log.deleted_at)}. Visible uniquement par le gérant.`));
    if (log.status === 'voided') {
      notices.push(h('div', { class: 'notice notice-warn' },
        `Log annulé le ${fmtDateTime(log.voided_at)} par ${log.voided_by_username ?? '—'}. Motif : ${log.void_reason}`));
    }
    if (log.is_override) {
      notices.push(h('div', { class: 'notice notice-warn' },
        `Écart : la recommandation était « ${recLabel} », l’agent a choisi « ${ACTIONS[log.action_taken]} ».` +
        (log.override_reason ? ` Justification : ${log.override_reason}` : (log.order_type !== 'none' ? ` Justifié par l’ordre (${ORDER_TYPES[log.order_type]}).` : ''))));
    }

    const sanction = card('Sanction', definitionList([
      ['Cible', h('a', { href: link('player.html', { u: log.target_normalized }) }, log.target_username)],
      log.target_normalized !== log.target_username.toLowerCase() ? ['Dossier joueur', log.target_normalized] : null,
      ['Type de cible', TARGET_TYPES[log.target_type]],
      ['Procédure', [procedureBadge(log.procedure), ' ', PROCEDURES[log.procedure]?.desc]],
      ['Infraction', [h('span', { class: 'cell-mono' }, log.offense_code), ' — ', log.offense_name, log.offense_requires_cs_approval ? approvalMark() : null]],
      ['Action prise', actionBadge(log.action_taken, log.warning_number, log.offense_max_warnings)],
      ['Jail', fmtJail(log.jail_seconds)],
      ['Warnings précédents', log.offense_max_warnings === null ? `${log.prior_warnings} (pas de maximum)` : `${log.prior_warnings} / ${log.offense_max_warnings}`],
      ['Recommandation', recLabel],
      ['Lieu', log.location],
    ]));

    const people = card('Intervenants', definitionList([
      ['Agent', [log.agent_username ?? '—', log.agent_service_number ? h('span', { class: 'muted' }, ` · ${log.agent_service_number}`) : null]],
      ['Saisi par', log.created_by_username],
      ['Approbateur', log.approver_username ?? (log.offense_requires_cs_approval ? 'Aucun' : '—')],
      log.approved_by ? ['Approbation confirmée', log.approval_confirmed_at ? `${log.approval_confirmed_by_username ?? '—'}, le ${fmtDateTime(log.approval_confirmed_at)}` : 'Non confirmée'] : null,
      ['Ordre', ORDER_TYPES[log.order_type]],
      log.order_type !== 'none' ? ['Ordre donné par', log.ordered_by] : null,
      ['Rapport fait', log.report_filed ? 'Oui' : (log.offense_report_required ? 'Non (obligatoire)' : 'Non')],
      ['Créé le', fmtDateTime(log.created_at)],
      ['Modifié le', fmtDateTime(log.updated_at)],
    ]));

    const notes = card('Notes', log.notes ? h('p', { style: { whiteSpace: 'pre-line' } }, log.notes) : h('p', { class: 'muted' }, 'Aucune note.'));
    const evidence = card(`Preuves (${log.evidence_urls?.length ?? 0})`, evidenceView(log.evidence_urls));

    const historyCard = card('Historique des modifications',
      history.length
        ? h('ol', { class: 'timeline' }, history.map((e) => h('li', { class: `timeline-item t-${e.action}` },
          h('div', { class: 'timeline-head' },
            h('strong', null, AUDIT_ACTIONS[e.action] ?? e.action),
            h('span', { class: 'muted' }, fmtDateTime(e.created_at)),
            h('span', null, 'par ', e.user_username ?? 'système')),
          e.action === 'INSERT' ? h('p', { class: 'muted small' }, 'Création du log.') : diffView(e.old_data, e.new_data, lookups))))
        : emptyState('Aucun historique.'));

    replace(main,
      h('p', { class: 'no-print' }, h('a', { href: 'logs.html' }, '← Logs')),
      pageHeader(`Log ${log.log_number}`, `${log.offense_code} — ${log.offense_name}`, ...actions),
      h('div', { class: 'print-only' }, h('p', null, `Coruscant Shock Troopers — imprimé le ${fmtDateTime(new Date().toISOString())}`)),
      h('div', { class: 'stack' },
        hero, notices,
        h('div', { class: 'grid grid-2' }, sanction, people),
        notes, evidence, historyCard));
  }

  await load();
});

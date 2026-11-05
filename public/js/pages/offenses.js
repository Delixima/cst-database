// Offense catalog (manager): create, edit, activate/deactivate, delete unused codes.
// This is the reference table behind the "new log" drop-down and the warning engine.

import { supabase, unwrap } from '../supabase.js';
import { requireAuth } from '../auth.js';
import { boot, renderShell, pageHeader } from '../layout.js';
import {
  h, replace, card, field, select, input, checkbox, loadingState, emptyState, errorState, table,
  procedureBadge, actionBadge, approvalMark, flag, button, withBusy, toast, confirmDialog, formDialog,
} from '../ui.js';
import { PROCEDURES, PROCEDURE_KEYS, PROCEDURE_PREFIX, ACTIONS, TARGETS, APPROVAL_MARK } from '../labels.js';
import { fmtJail } from '../format.js';

const DEFAULT_ACTION_BY_PROCEDURE = {
  alpha: 'arrest', foxtrot: 'arrest', tango: 'termination', delta: 'relocation', lima: 'search', hotel: 'detention',
};
const DEFAULT_TARGET_BY_PROCEDURE = {
  alpha: 'personnel', foxtrot: 'immigrant', tango: 'both', delta: 'both', lima: 'immigrant', hotel: 'both',
};

boot(async () => {
  const ctx = await requireAuth({ minLevel: 5 });
  const main = renderShell(ctx, 'offenses');
  let showInactive = true;

  async function load() {
    replace(main, loadingState('Chargement du référentiel…'));
    try {
      const [offenses, usage] = await Promise.all([
        supabase.from('offenses').select('*').order('procedure').order('code_number').then(unwrap),
        supabase.from('warning_counters').select('offense_id').then(unwrap),
      ]);
      render(offenses, new Set(usage.map((u) => u.offense_id)));
    } catch (err) {
      replace(main, errorState(err, load));
    }
  }

  function render(offenses, used) {
    const toggle = checkbox('Afficher les infractions désactivées', showInactive);
    toggle.input.addEventListener('change', () => { showInactive = toggle.input.checked; render(offenses, used); });

    const sections = PROCEDURE_KEYS.map((p) => {
      const list = offenses.filter((o) => o.procedure === p && (showInactive || o.active));
      const add = button(`+ Ajouter (${PROCEDURES[p].label})`, () => edit(null, p, offenses), 'ghost btn-sm');
      return card(null,
        h('h2', { class: 'card-title' }, h('span', null, procedureBadge(p), ' ', PROCEDURES[p].desc), add),
        list.length
          ? table([
            { label: 'Code', className: 'cell-mono nowrap', render: (o) => [o.code, o.requires_cs_approval ? approvalMark() : null] },
            { label: 'Libellé', render: (o) => o.name },
            { label: 'Cible', className: 'nowrap', render: (o) => TARGETS[o.target] },
            { label: 'Jail', className: 'nowrap', render: (o) => fmtJail(o.jail_seconds) },
            { label: 'Warnings', className: 'nowrap', render: (o) => (o.max_warnings === null ? 'Non applicable' : o.max_warnings === 0 ? 'Immédiat' : `${o.max_warnings} max`) },
            { label: 'Action par défaut', render: (o) => actionBadge(o.default_action) },
            { label: 'Options', render: (o) => [o.report_required ? flag('Rapport', 'danger') : null, o.requires_cs_approval ? flag(`${APPROVAL_MARK} CS`, 'warn') : null] },
            { label: 'Statut', render: (o) => (o.active ? flag('Active', 'info') : flag('Désactivée', 'muted')) },
            {
              label: '', className: 'right nowrap', render: (o) => {
                const toggleBtn = button(o.active ? 'Désactiver' : 'Activer', null, 'ghost btn-sm');
                toggleBtn.addEventListener('click', () => withBusy(toggleBtn, async () => {
                  unwrap(await supabase.from('offenses').update({ active: !o.active }).eq('id', o.id).select('id'));
                  toast(`${o.code} ${o.active ? 'désactivée' : 'activée'}.`, 'success');
                  await load();
                }));
                const del = used.has(o.id) ? null : button('Supprimer', () => remove(o), 'danger btn-sm', { title: 'Possible uniquement si aucun log ne l’utilise' });
                return [button('Modifier', () => edit(o, o.procedure, offenses), 'ghost btn-sm'), ' ', toggleBtn, ' ', del];
              },
            },
          ], list, { rowClass: (o) => (o.active ? '' : 'row-voided') })
          : emptyState(p === 'lima' || p === 'hotel'
            ? `Aucune infraction ${PROCEDURES[p].label} définie pour l’instant (TBD dans le guide).`
            : 'Aucune infraction.'));
    });

    replace(main,
      pageHeader('Référentiel des infractions', 'Liste déroulante et moteur de calcul des logs. Désactivez plutôt que supprimer : les anciens logs restent liés.',
        button('+ Nouvelle infraction', () => edit(null, 'alpha', offenses), 'primary')),
      h('div', { class: 'row', style: { marginBottom: '14px' } }, toggle),
      h('div', { class: 'stack' }, sections));
  }

  async function remove(o) {
    const r = await confirmDialog({
      title: `Supprimer ${o.code}`,
      message: 'Suppression définitive. Impossible si un log utilise cette infraction (désactivez-la dans ce cas).',
      confirmLabel: 'Supprimer', danger: true, typeToConfirm: o.code,
    });
    if (!r) return;
    await withBusy(null, async () => {
      const rows = unwrap(await supabase.from('offenses').delete().eq('id', o.id).select('id'));
      if (!rows.length) throw new Error('Suppression refusée.');
      toast(`${o.code} supprimée.`, 'success');
      await load();
    });
  }

  function suggestCode(procedure, offenses) {
    const nums = offenses.filter((o) => o.procedure === procedure).map((o) => Math.floor(Number(o.code_number)));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    return `${PROCEDURE_PREFIX[procedure]}${next}.0`;
  }

  async function edit(o, procedure, offenses) {
    const isNew = !o;
    const procSel = select(Object.fromEntries(PROCEDURE_KEYS.map((k) => [k, `${PROCEDURES[k].label} — ${PROCEDURES[k].desc}`])), { value: o?.procedure ?? procedure });
    const code = input({ value: o?.code ?? suggestCode(procedure, offenses), maxlength: 8, placeholder: 'A15.0', spellcheck: 'false' });
    const name = input({ value: o?.name ?? '', maxlength: 200 });
    const target = select(TARGETS, { value: o?.target ?? DEFAULT_TARGET_BY_PROCEDURE[procedure] });
    const defaultAction = select(ACTIONS, { value: o?.default_action ?? DEFAULT_ACTION_BY_PROCEDURE[procedure] });
    const jail = input({ type: 'number', min: 1, max: 86400, step: 1, value: o?.jail_seconds ?? '' });
    const warningsMode = select({ immediate: 'Immédiat (0)', count: 'Nombre de Warnings', none: 'Non applicable' }, {
      value: o ? (o.max_warnings === null ? 'none' : o.max_warnings === 0 ? 'immediate' : 'count') : 'immediate',
    });
    const maxWarnings = input({ type: 'number', min: 1, max: 20, step: 1, value: o?.max_warnings > 0 ? o.max_warnings : 3 });
    const approval = checkbox(`Approbation d’un Company Sergeant ou plus requise ${APPROVAL_MARK}`, o?.requires_cs_approval ?? false);
    const reportReq = checkbox('Rapport obligatoire', o?.report_required ?? false);
    const active = checkbox('Active (proposée dans le formulaire)', o?.active ?? true);

    const fCode = field('Code', code, 'Lettre de la procédure + numéro, ex. L1.0, H2.0', { required: true });
    const fName = field('Libellé (tel que dans le guide)', name, null, { required: true });
    const fJail = field('Jail (secondes)', jail, 'Vide si non applicable');
    const fMax = field('Warnings max', maxWarnings);
    const syncMax = () => { fMax.hidden = warningsMode.value !== 'count'; };
    warningsMode.addEventListener('change', syncMax);
    syncMax();
    procSel.addEventListener('change', () => {
      if (isNew) {
        code.value = suggestCode(procSel.value, offenses);
        target.value = DEFAULT_TARGET_BY_PROCEDURE[procSel.value];
        defaultAction.value = DEFAULT_ACTION_BY_PROCEDURE[procSel.value];
      }
    });

    const body = h('div', { class: 'form-grid' },
      h('div', { class: 'full' }, field('Procédure', procSel, null, { required: true })),
      fCode, field('Cible', target, null, { required: true }),
      h('div', { class: 'full' }, fName),
      field('Action par défaut', defaultAction, null, { required: true }), fJail,
      field('Warnings avant arrestation', warningsMode, '0 = arrestation immédiate. Le max atteint n’autorise pas l’arrestation : seul le dépassement l’autorise.'), fMax,
      h('div', { class: 'full stack', style: { gap: '8px' } }, approval, reportReq, active),
      o ? h('p', { class: 'full small muted' }, 'Modifier une infraction n’altère pas les logs déjà enregistrés (leurs Warnings et recommandations sont conservés).') : null);

    const saved = await formDialog({
      title: isNew ? 'Nouvelle infraction' : `Modifier ${o.code}`,
      body, wide: true, submitLabel: isNew ? 'Créer' : 'Enregistrer',
      onSubmit: async () => {
        [fCode, fName, fJail, fMax].forEach((f) => f.setError(''));
        const c = code.value.trim().toUpperCase();
        const p = procSel.value;
        let bad = false;
        if (!/^[AFTDLH][0-9]{1,3}\.[0-9]{1,2}$/.test(c)) { fCode.setError('Format attendu : lettre + numéro, ex. A15.0'); bad = true; }
        else if (c[0] !== PROCEDURE_PREFIX[p]) { fCode.setError(`Pour ${PROCEDURES[p].label}, le code doit commencer par « ${PROCEDURE_PREFIX[p]} ».`); bad = true; }
        if (name.value.trim().length < 3 || name.value.trim().length > 200) { fName.setError('3 à 200 caractères.'); bad = true; }
        let jailVal = null;
        if (jail.value !== '') {
          jailVal = Number(jail.value);
          if (!Number.isInteger(jailVal) || jailVal < 1 || jailVal > 86400) { fJail.setError('Entier entre 1 et 86400.'); bad = true; }
        }
        let maxVal = warningsMode.value === 'none' ? null : 0;
        if (warningsMode.value === 'count') {
          maxVal = Number(maxWarnings.value);
          if (!Number.isInteger(maxVal) || maxVal < 1 || maxVal > 20) { fMax.setError('Entier entre 1 et 20.'); bad = true; }
        }
        if (bad) throw new Error('Corrigez les champs signalés.');
        const payload = {
          code: c, procedure: p, name: name.value.trim(), target: target.value,
          default_action: defaultAction.value, jail_seconds: jailVal, max_warnings: maxVal,
          requires_cs_approval: approval.input.checked, report_required: reportReq.input.checked, active: active.input.checked,
        };
        if (isNew) unwrap(await supabase.from('offenses').insert(payload).select('id').single());
        else {
          const rows = unwrap(await supabase.from('offenses').update(payload).eq('id', o.id).select('id'));
          if (!rows.length) throw new Error('Modification refusée.');
        }
        return true;
      },
    });
    if (saved) {
      toast(isNew ? 'Infraction créée.' : 'Infraction mise à jour.', 'success');
      await load();
    }
  }

  await load();
});

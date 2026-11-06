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
  alpha: 'arrest', foxtrot: 'arrest', tango: 'termination', delta: 'relocation', lima: 'search', hotel: 'detention', sierra: 'arrest',
};
const DEFAULT_TARGET_BY_PROCEDURE = {
  alpha: 'personnel', foxtrot: 'immigrant', tango: 'both', delta: 'both', lima: 'immigrant', hotel: 'both', sierra: 'personnel',
};

boot(async () => {
  const ctx = await requireAuth({ minLevel: 5 });
  const main = renderShell(ctx, 'offenses');
  let showInactive = true;

  async function load() {
    replace(main, loadingState('Loading the catalog…'));
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
    const toggle = checkbox('Show inactive offenses', showInactive);
    toggle.input.addEventListener('change', () => { showInactive = toggle.input.checked; render(offenses, used); });

    const sections = PROCEDURE_KEYS.map((p) => {
      const list = offenses.filter((o) => o.procedure === p && (showInactive || o.active));
      const add = button(`+ Add (${PROCEDURES[p].label})`, () => edit(null, p, offenses), 'ghost btn-sm');
      return card(null,
        h('h2', { class: 'card-title' }, h('span', null, procedureBadge(p), ' ', PROCEDURES[p].desc), add),
        list.length
          ? table([
            { label: 'Code', className: 'cell-mono nowrap', render: (o) => [o.code, o.requires_cs_approval ? approvalMark() : null] },
            { label: 'Name', render: (o) => o.name },
            { label: 'Target', className: 'nowrap', render: (o) => TARGETS[o.target] },
            { label: 'Jail', className: 'nowrap', render: (o) => fmtJail(o.jail_seconds) },
            { label: 'Warnings', className: 'nowrap', render: (o) => (o.max_warnings === null ? 'Not applicable' : o.max_warnings === 0 ? 'Immediate' : `${o.max_warnings} max`) },
            { label: 'Default action', render: (o) => actionBadge(o.default_action) },
            { label: 'Options', render: (o) => [o.report_required ? flag('Report', 'danger') : null, o.requires_cs_approval ? flag(`${APPROVAL_MARK} CS`, 'warn') : null] },
            { label: 'Status', render: (o) => (o.active ? flag('Active', 'info') : flag('Inactive', 'muted')) },
            {
              label: '', className: 'right nowrap', render: (o) => {
                const toggleBtn = button(o.active ? 'Deactivate' : 'Activate', null, 'ghost btn-sm');
                toggleBtn.addEventListener('click', () => withBusy(toggleBtn, async () => {
                  unwrap(await supabase.from('offenses').update({ active: !o.active }).eq('id', o.id).select('id'));
                  toast(`${o.code} ${o.active ? 'deactivated' : 'activated'}.`, 'success');
                  await load();
                }));
                const del = used.has(o.id) ? null : button('Delete', () => remove(o), 'danger btn-sm', { title: 'Only possible if no log uses it' });
                return [button('Edit', () => edit(o, o.procedure, offenses), 'ghost btn-sm'), ' ', toggleBtn, ' ', del];
              },
            },
          ], list, { rowClass: (o) => (o.active ? '' : 'row-voided') })
          : emptyState(p === 'lima' || p === 'hotel'
            ? `No ${PROCEDURES[p].label} offense defined yet (TBD in the guide).`
            : 'No offenses.'));
    });

    replace(main,
      pageHeader('Offense catalog', 'Drop-down list and calculation engine for logs. Deactivate rather than delete: older logs stay linked.',
        button('+ New offense', () => edit(null, 'alpha', offenses), 'primary')),
      h('div', { class: 'row', style: { marginBottom: '14px' } }, toggle),
      h('div', { class: 'stack' }, sections));
  }

  async function remove(o) {
    const r = await confirmDialog({
      title: `Delete ${o.code}`,
      message: 'Permanent deletion. Not possible if a log uses this offense (deactivate it instead).',
      confirmLabel: 'Delete', danger: true, typeToConfirm: o.code,
    });
    if (!r) return;
    await withBusy(null, async () => {
      const rows = unwrap(await supabase.from('offenses').delete().eq('id', o.id).select('id'));
      if (!rows.length) throw new Error('Delete refused.');
      toast(`${o.code} deleted.`, 'success');
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
    const warningsMode = select({ immediate: 'Immediate (0)', count: 'Number of warnings', none: 'Not applicable' }, {
      value: o ? (o.max_warnings === null ? 'none' : o.max_warnings === 0 ? 'immediate' : 'count') : 'immediate',
    });
    const maxWarnings = input({ type: 'number', min: 1, max: 20, step: 1, value: o?.max_warnings > 0 ? o.max_warnings : 3 });
    const approval = checkbox(`Approval from a Company Sergeant or above required ${APPROVAL_MARK}`, o?.requires_cs_approval ?? false);
    const reportReq = checkbox('Report required', o?.report_required ?? false);
    const active = checkbox('Active (offered in the log form)', o?.active ?? true);

    const fCode = field('Code', code, 'Procedure letter + number, e.g. L1.0, H2.0', { required: true });
    const fName = field('Name (as in the guide)', name, null, { required: true });
    const fJail = field('Jail (seconds)', jail, 'Empty if not applicable');
    const fMax = field('Max warnings', maxWarnings);
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
      h('div', { class: 'full' }, field('Procedure', procSel, null, { required: true })),
      fCode, field('Target', target, null, { required: true }),
      h('div', { class: 'full' }, fName),
      field('Default action', defaultAction, null, { required: true }), fJail,
      field('Warnings before arrest', warningsMode, '0 = immediate arrest. Reaching the max does not authorize the arrest: only exceeding it does.'), fMax,
      h('div', { class: 'full stack', style: { gap: '8px' } }, approval, reportReq, active),
      o ? h('p', { class: 'full small muted' }, 'Editing an offense does not alter logs already recorded (their warnings and recommendations are kept).') : null);

    const saved = await formDialog({
      title: isNew ? 'New offense' : `Edit ${o.code}`,
      body, wide: true, submitLabel: isNew ? 'Create' : 'Save',
      onSubmit: async () => {
        [fCode, fName, fJail, fMax].forEach((f) => f.setError(''));
        const c = code.value.trim().toUpperCase();
        const p = procSel.value;
        let bad = false;
        if (!/^[AFTDLHS][0-9]{1,3}\.[0-9]{1,2}$/.test(c)) { fCode.setError('Expected format: letter + number, e.g. A15.0'); bad = true; }
        else if (c[0] !== PROCEDURE_PREFIX[p]) { fCode.setError(`For ${PROCEDURES[p].label}, the code must start with "${PROCEDURE_PREFIX[p]}".`); bad = true; }
        if (name.value.trim().length < 3 || name.value.trim().length > 200) { fName.setError('3 to 200 characters.'); bad = true; }
        let jailVal = null;
        if (jail.value !== '') {
          jailVal = Number(jail.value);
          if (!Number.isInteger(jailVal) || jailVal < 1 || jailVal > 86400) { fJail.setError('Whole number between 1 and 86400.'); bad = true; }
        }
        let maxVal = warningsMode.value === 'none' ? null : 0;
        if (warningsMode.value === 'count') {
          maxVal = Number(maxWarnings.value);
          if (!Number.isInteger(maxVal) || maxVal < 1 || maxVal > 20) { fMax.setError('Whole number between 1 and 20.'); bad = true; }
        }
        if (bad) throw new Error('Fix the highlighted fields.');
        const payload = {
          code: c, procedure: p, name: name.value.trim(), target: target.value,
          default_action: defaultAction.value, jail_seconds: jailVal, max_warnings: maxVal,
          requires_cs_approval: approval.input.checked, report_required: reportReq.input.checked, active: active.input.checked,
        };
        if (isNew) unwrap(await supabase.from('offenses').insert(payload).select('id').single());
        else {
          const rows = unwrap(await supabase.from('offenses').update(payload).eq('id', o.id).select('id'));
          if (!rows.length) throw new Error('Update refused.');
        }
        return true;
      },
    });
    if (saved) {
      toast(isNew ? 'Offense created.' : 'Offense updated.', 'success');
      await load();
    }
  }

  await load();
});

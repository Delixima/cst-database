// New log / edit log (log-new?edit=<uuid>).
// Smart form: player autocomplete, live warning recommendation from the
// database, ⧭ approver, HICOM/ISB orders, evidence URLs with previews.
// The database recomputes everything on save; this page only guides the agent.

import { supabase, unwrap } from '../supabase.js';
import { requireAuth, canEditLog } from '../auth.js';
import { boot, renderShell, pageHeader } from '../layout.js';
import {
  h, replace, field, select, input, checkbox, loadingState, errorState, errorMessage,
  link, procedureBadge, button,
} from '../ui.js';
import {
  PROCEDURES, PROCEDURE_KEYS, ACTIONS, TARGET_TYPES, ORDER_TYPES, ROLES,
  recommendationLabel, actionTone, USERNAME_RE, APPROVAL_MARK,
} from '../labels.js';
import {
  qs, debounce, escapeLike, toLocalInput, fromLocalInput, fmtJail, fmtDateTime,
  isValidEvidenceUrl, looksLikeImage, isUuid,
} from '../format.js';

const MAX_EVIDENCE = 10;
const JAIL_ACTIONS = new Set(['arrest', 'detention']);

boot(async () => {
  const ctx = await requireAuth({ minLevel: 2 });
  const editId = qs('edit');
  const main = renderShell(ctx, editId ? 'logs' : 'new');
  replace(main, loadingState('Loading the form…'));

  if (editId && !isUuid(editId)) {
    replace(main, errorState('Invalid log ID.'));
    return;
  }

  let offenses, approvers, agents, existing;
  try {
    [offenses, approvers, agents, existing] = await Promise.all([
      supabase.from('offenses').select('*').order('procedure').order('code_number').then(unwrap),
      supabase.from('profiles').select('id, roblox_username, role, rank:ranks(name)')
        .in('role', ['cs', 'officer', 'manager']).eq('active', true).order('roblox_username').then(unwrap),
      ctx.perms.officer
        ? supabase.from('profiles').select('id, roblox_username, role')
          .in('role', ['trooper', 'cs', 'officer', 'manager']).eq('active', true).order('roblox_username').then(unwrap)
        : Promise.resolve([]),
      editId
        ? supabase.from('sanction_logs_expanded').select('*').eq('id', editId).maybeSingle().then(unwrap)
        : Promise.resolve(null),
    ]);
  } catch (err) {
    replace(main, errorState(err, () => location.reload()));
    return;
  }

  if (editId) {
    if (!existing) {
      replace(main, errorState('Log not found or not accessible.'));
      return;
    }
    if (!canEditLog(ctx, existing)) {
      replace(main, pageHeader(`Edit ${existing.log_number}`),
        errorState('Your role cannot edit this log (a trooper can only edit their own logs less than 24 h old).'),
        h('p', null, h('a', { href: link('log', { id: existing.id }) }, '← Back to the log')));
      return;
    }
  }

  if (existing) document.title = `Edit ${existing.log_number} — CST`;

  const offenseById = new Map(offenses.map((o) => [o.id, o]));
  const state = {
    rec: null,
    recLoading: false,
    recError: null,
    recSeq: 0,
    actionTouched: Boolean(existing),
    jailTouched: Boolean(existing),
    submitting: false,
  };

  // ---------------------------------------------------------------- controls

  const targetInput = input({
    maxlength: 20, autocomplete: 'off', spellcheck: 'false', list: 'player-suggestions',
    placeholder: 'Exact Roblox username', value: existing?.target_username ?? qs('u') ?? '',
  });
  const datalist = h('datalist', { id: 'player-suggestions' });
  const fTarget = field('Target Roblox username', targetInput, 'Free text, 3 to 20 characters. Known usernames are suggested.', { required: true });

  const offenseSelect = h('select', { class: 'input' }, h('option', { value: '' }, '— Choose an offense —'));
  for (const p of PROCEDURE_KEYS) {
    const list = offenses.filter((o) => o.procedure === p && (o.active || o.id === existing?.offense_id));
    const group = h('optgroup', { label: `${PROCEDURES[p].label} — ${PROCEDURES[p].desc}` });
    if (!list.length) group.append(h('option', { value: '', disabled: true }, 'No offense defined'));
    for (const o of list) {
      group.append(h('option', { value: o.id },
        `${o.code} — ${o.name}${o.requires_cs_approval ? ' ' + APPROVAL_MARK : ''}${o.active ? '' : ' (inactive)'}`));
    }
    offenseSelect.append(group);
  }
  const presetCode = qs('offense');
  offenseSelect.value = existing?.offense_id ?? offenses.find((o) => o.code === presetCode && o.active)?.id ?? '';
  const offenseInfo = h('div', { class: 'field-hint' });
  const fOffense = field('Offense', offenseSelect, offenseInfo, { required: true });

  const ttRadios = Object.entries(TARGET_TYPES).map(([value, label]) => {
    const r = h('input', { type: 'radio', name: 'target_type', value });
    return { value, r, el: h('label', { class: 'radio-pill' }, r, h('span', null, label)) };
  });
  const ttGroup = h('div', { class: 'radio-group', role: 'radiogroup', id: 'target-type' }, ttRadios.map((t) => t.el));
  const ttHint = h('span');
  const fTargetType = field('Target type', ttGroup, ttHint, { required: true });
  const getTargetType = () => ttRadios.find((t) => t.r.checked)?.value ?? '';
  const setTargetType = (v) => ttRadios.forEach((t) => { t.r.checked = t.value === v; });
  setTargetType(existing?.target_type ?? '');

  const orderSelect = select(ORDER_TYPES, { value: existing?.order_type ?? 'none' });
  const fOrder = field('Order', orderSelect, 'HICOM (C1+) and ISB can order any action on anyone.');
  const orderedByInput = input({ maxlength: 100, placeholder: 'e.g. HICOM, ISB, officer username', value: existing?.ordered_by ?? '' });
  const fOrderedBy = field('Ordered by', orderedByInput, null, { required: true });

  const occurredInput = input({ type: 'datetime-local', value: toLocalInput(existing?.occurred_at ?? new Date()) });
  occurredInput.max = toLocalInput(new Date(Date.now() + 5 * 60 * 1000));
  const fOccurred = field('Date and time of the incident', occurredInput, null, { required: true });

  const actionSelect = select(ACTIONS, { value: existing?.action_taken ?? '', placeholder: '— Action taken —' });
  const fAction = field('Action taken', actionSelect, 'Pre-filled with the recommendation. You can change it: the override will be recorded.', { required: true });

  const jailInput = input({ type: 'number', min: 1, max: 86400, step: 1, value: existing?.jail_seconds ?? '' });
  const fJail = field('Jail duration (seconds)', jailInput, 'Pre-filled from the catalog. Empty = the offense default.');

  const overrideReason = h('textarea', { class: 'input', rows: 2, maxlength: 500, placeholder: 'Why this action instead of the recommendation?' });
  overrideReason.value = existing?.override_reason ?? '';
  const overrideText = h('p', { class: 'small' });
  const fOverride = field('Override justification', overrideReason, 'Required, except under an AOS / KOS / HICOM / ISB order.');
  const overrideBox = h('div', { class: 'override-box full', hidden: true }, h('strong', null, 'Override of the recommendation'), overrideText, fOverride);

  const approverSelect = select(
    approvers.map((a) => ({ value: a.id, label: `${a.roblox_username ?? '(no username)'} — ${ROLES[a.role]}${a.rank?.name ? ' · ' + a.rank.name : ''}` })),
    { value: existing?.approved_by ?? (ctx.perms.cs ? ctx.user.id : ''), placeholder: '— Select the approver —' });
  const fApprover = field(`Approver ${APPROVAL_MARK} (Company Sergeant or above)`, approverSelect,
    'The CS or above who approved the arrest. They must confirm it on the site if it is not you.', { required: true });

  const agentSelect = ctx.perms.officer
    ? select(agents.map((a) => ({ value: a.id, label: `${a.roblox_username ?? '(no username)'} — ${ROLES[a.role]}` })),
      { value: existing?.agent_id ?? ctx.user.id })
    : null;
  const fAgent = agentSelect
    ? field('Agent', agentSelect, 'Officers and manager: you can log on behalf of another agent.')
    : field('Agent', input({ value: existing?.agent_username ?? ctx.profile.roblox_username ?? '', readOnly: true, disabled: true }));

  const locationInput = input({ maxlength: 120, placeholder: 'e.g. Border, Hangar 3, Senate…', value: existing?.location ?? '' });
  const fLocation = field('Location', locationInput);

  const report = checkbox('Report filed', existing?.report_filed ?? false);
  const reportHint = h('span');
  const fReport = field('Report', report, reportHint);

  const notes = h('textarea', { class: 'input', rows: 4, maxlength: 4000, placeholder: 'Context, sequence of events, witnesses…' });
  notes.value = existing?.notes ?? '';
  const notesCount = h('span');
  const fNotes = field('Notes', notes, notesCount, { className: 'full' });
  const updateNotesCount = () => { notesCount.textContent = `${notes.value.length} / 4000`; };
  notes.addEventListener('input', updateNotesCount);
  updateNotesCount();

  // Evidence editor
  const evidenceList = h('div', { class: 'evidence-editor' });
  const addEvidenceBtn = button('+ Add evidence', () => addEvidence(''), 'ghost btn-sm');
  const fEvidence = field('Evidence (https links)', h('div', null, evidenceList, addEvidenceBtn),
    `Hosted screenshots or videos (Discord, Imgur, YouTube…). ${MAX_EVIDENCE} links maximum.`, { className: 'full' });

  function addEvidence(value) {
    if (evidenceList.children.length >= MAX_EVIDENCE) return;
    const url = input({ type: 'url', value, placeholder: 'https://…', maxlength: 2048, inputmode: 'url' });
    const preview = h('div');
    const remove = button('Remove', () => { row.remove(); syncEvidenceBtn(); }, 'ghost btn-sm', { 'aria-label': 'Remove this evidence' });
    const row = h('div', { class: 'evidence-row' }, url, remove, preview);
    const refresh = () => {
      const v = url.value.trim();
      replace(preview);
      url.classList.toggle('invalid', v !== '' && !isValidEvidenceUrl(v));
      if (isValidEvidenceUrl(v) && looksLikeImage(v)) {
        const img = h('img', { class: 'evidence-thumb', src: v, alt: 'Preview', loading: 'lazy', referrerpolicy: 'no-referrer' });
        img.addEventListener('error', () => img.remove());
        preview.append(img);
      }
    };
    url.addEventListener('change', refresh);
    url.addEventListener('input', debounce(refresh, 500));
    evidenceList.append(row);
    refresh();
    syncEvidenceBtn();
    if (!value) url.focus();
  }
  function syncEvidenceBtn() {
    addEvidenceBtn.disabled = evidenceList.children.length >= MAX_EVIDENCE;
  }
  (existing?.evidence_urls ?? []).forEach((u) => addEvidence(u));

  // Recommendation panel
  const recoBody = h('div');
  const recoCard = h('aside', { class: 'card reco', 'aria-live': 'polite' }, h('h2', { class: 'card-title' }, 'Live calculation'), recoBody);

  const formError = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, existing ? 'Save changes' : 'Save log');
  const cancelHref = existing ? link('log', { id: existing.id }) : 'dashboard';

  const form = h('form', { class: 'card', novalidate: true },
    h('div', { class: 'form-grid' },
      fTarget, fOffense,
      fTargetType, fOccurred,
      fOrder, fOrderedBy,
      fAction, fJail,
      overrideBox,
      fApprover, fAgent,
      fLocation, fReport,
      fNotes, fEvidence),
    datalist,
    formError,
    h('div', { class: 'form-actions' }, h('a', { class: 'btn btn-ghost', href: cancelHref }, 'Cancel'), submitBtn));

  const headerSub = existing
    ? `Created on ${fmtDateTime(existing.created_at)} by ${existing.created_by_username ?? '—'}. Warnings and the recommendation are recomputed by the database on save.`
    : 'Warnings, the recommendation and the number are computed by the database.';
  replace(main,
    pageHeader(existing ? `Edit ${existing.log_number}` : 'New log', headerSub),
    existing?.status === 'voided' ? h('div', { class: 'notice notice-warn' }, 'This log is voided: it does not count in statistics or warnings.') : null,
    h('div', { class: 'log-form-layout' }, form, recoCard));

  // ---------------------------------------------------------------- logic

  const currentOffense = () => offenseById.get(offenseSelect.value) ?? null;

  function updateVisibility() {
    const offense = currentOffense();
    const order = orderSelect.value;
    const action = actionSelect.value;

    // Target type: implied by the offense unless HICOM/ISB order
    const locked = offense && offense.target !== 'both' && order !== 'hicom_isb_order';
    if (locked) setTargetType(offense.target);
    ttRadios.forEach((t) => { t.r.disabled = Boolean(locked); });
    ttHint.textContent = locked
      ? `Set by the offense (${TARGET_TYPES[offense.target]}).`
      : (offense?.target === 'both' ? 'This offense applies to personnel and immigrants alike.' : 'HICOM / ISB order: any target.');
    if (!offense) ttHint.textContent = '';

    offenseInfo.textContent = offense
      ? `${PROCEDURES[offense.procedure].label} : ${PROCEDURES[offense.procedure].desc}.`
      : '';

    fOrderedBy.hidden = order === 'none';
    // The approver only matters for an arrest on a ⧭ offense
    fApprover.hidden = !(offense?.requires_cs_approval && action === 'arrest');
    fJail.hidden = !JAIL_ACTIONS.has(action);

    if (!state.jailTouched && JAIL_ACTIONS.has(action)) {
      jailInput.value = offense?.jail_seconds ?? '';
    }

    reportHint.textContent = offense?.report_required ? 'A report is required for this offense.' : 'Check once the report has been written.';
    reportHint.className = offense?.report_required ? 'flag flag-danger' : '';

    const rec = state.rec;
    const overridden = Boolean(rec && action && action !== rec.recommended_action);
    overrideBox.hidden = !overridden;
    if (overridden) {
      overrideText.textContent =
        `Recommendation: "${recommendationLabel(rec.recommendation_code, rec.recommended_warning_number, rec.max_warnings)}". ` +
        `Chosen action: "${ACTIONS[action]}". This override will be recorded and flagged on the log.`;
    }
  }

  function dots(prior, max, overflow) {
    if (!max || max > 10) return null;
    const wrap = h('span', { class: 'counter-dots', 'aria-hidden': 'true' });
    for (let i = 0; i < max; i++) wrap.append(h('span', { class: ['counter-dot', i < prior && 'on'] }));
    if (overflow) wrap.append(h('span', { class: 'counter-dot over' }));
    return wrap;
  }

  function renderReco() {
    const offense = currentOffense();
    if (state.recLoading) {
      replace(recoBody, loadingState('Calculating…'));
      return;
    }
    if (state.recError) {
      replace(recoBody, h('div', { class: 'notice notice-danger' }, `Calculation unavailable: ${errorMessage(state.recError)}. The database will recompute on save.`));
      return;
    }
    const rec = state.rec;
    if (!rec || !offense) {
      replace(recoBody, h('p', { class: 'muted' }, 'Enter a valid username and choose an offense to see prior warnings and the recommended action.'));
      return;
    }
    const tone = actionTone(rec.recommended_action);
    const label = recommendationLabel(rec.recommendation_code, rec.recommended_warning_number, rec.max_warnings);
    const prior = rec.prior_warnings;
    const max = rec.max_warnings;
    const priorText = max === null || max === undefined
      ? `${prior} (no maximum)`
      : (max === 0 ? 'N/A (immediate)' : `${prior} / ${max}`);

    const alerts = [];
    if (rec.is_alias) {
      alerts.push(h('div', { class: 'notice' }, `Former username: this log will be filed under the "${rec.target_normalized}" record.`));
    }
    if (rec.recommendation_code === 'arrest_authorized') {
      alerts.push(h('div', { class: 'notice notice-danger' },
        `Maximum already reached (${prior}/${max}): this new breach authorizes the arrest, without a new warning.`));
    } else if (rec.recommendation_code === 'warning' && max && rec.recommended_warning_number === max) {
      alerts.push(h('div', { class: 'notice notice-warn' },
        `Last warning (${max}/${max}). Reaching the maximum does not authorize the arrest: the next breach will.`));
    }
    if (rec.requires_cs_approval) {
      alerts.push(h('div', { class: 'notice notice-warn' },
        `${APPROVAL_MARK} An arrest for this offense requires approval from a Company Sergeant or above BEFORE the arrest.`));
    }
    if (rec.report_required) {
      alerts.push(h('div', { class: 'notice notice-danger' }, 'A report is required for this offense.'));
    }
    if (orderSelect.value === 'hicom_isb_order') {
      alerts.push(h('div', { class: 'notice' }, 'HICOM / ISB order: any action is allowed; any override is justified by the order.'));
    }

    replace(recoBody,
      h('div', { class: `reco-main tone-${tone}` },
        h('span', { class: 'reco-kicker' }, 'Recommended action'),
        h('span', { class: 'reco-action' }, label)),
      h('ul', { class: 'reco-list' },
        h('li', null, h('span', null, 'Prior warnings'), h('strong', null, priorText, ' ', dots(prior, max, rec.recommendation_code === 'arrest_authorized'))),
        h('li', null, h('span', null, 'Jail'), h('strong', null, fmtJail(rec.jail_seconds))),
        h('li', null, h('span', null, 'Procedure'), h('strong', null, procedureBadge(rec.procedure))),
        h('li', null, h('span', null, `CS approval ${APPROVAL_MARK}`), h('strong', null, rec.requires_cs_approval ? 'Required' : 'No')),
        h('li', null, h('span', null, 'Report required'), h('strong', null, rec.report_required ? 'Yes' : 'No')),
        rec.last_reset_at ? h('li', null, h('span', null, 'Last warning reset'), h('strong', null, fmtDateTime(rec.last_reset_at))) : null),
      h('div', { class: 'reco-alerts' }, alerts),
      h('p', { class: 'small', style: { marginTop: '12px' } },
        h('a', { href: link('player', { u: rec.target_normalized }), target: '_blank', rel: 'noopener' }, 'Open the player record ↗')));
  }

  async function refreshRec() {
    const name = targetInput.value.trim();
    const offense = currentOffense();
    if (!USERNAME_RE.test(name) || !offense) {
      state.rec = null;
      state.recError = null;
      state.recLoading = false;
      renderReco();
      updateVisibility();
      return;
    }
    const seq = ++state.recSeq;
    state.recLoading = true;
    renderReco();
    const { data, error } = await supabase.rpc('get_recommendation', {
      p_target_username: name,
      p_offense_id: offense.id,
      p_order_type: orderSelect.value || 'none',
      p_occurred_at: fromLocalInput(occurredInput.value) ?? new Date().toISOString(),
      p_exclude_log: existing?.id ?? null,
    });
    if (seq !== state.recSeq) return;
    state.recLoading = false;
    if (error) {
      state.rec = null;
      state.recError = error;
    } else {
      state.rec = data;
      state.recError = null;
      if (!state.actionTouched) actionSelect.value = data.recommended_action;
    }
    renderReco();
    updateVisibility();
  }
  const refreshRecSoon = debounce(refreshRec, 300);

  const suggest = debounce(async () => {
    const v = targetInput.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (v.length < 2) return;
    const [players, aliases] = await Promise.all([
      supabase.from('players').select('target_normalized, last_username, total_logs')
        .ilike('target_normalized', `${escapeLike(v)}%`).order('last_sanction_at', { ascending: false, nullsFirst: false }).limit(8),
      supabase.from('player_aliases').select('alias_normalized, canonical_normalized')
        .ilike('alias_normalized', `${escapeLike(v)}%`).limit(4),
    ]);
    const opts = [];
    for (const p of players.data ?? []) opts.push(h('option', { value: p.last_username }, `${p.total_logs} log(s)`));
    for (const a of aliases.data ?? []) opts.push(h('option', { value: a.alias_normalized }, `former username of ${a.canonical_normalized}`));
    replace(datalist, opts);
  }, 200);

  targetInput.addEventListener('input', () => { fTarget.setError(''); suggest(); refreshRecSoon(); });
  targetInput.addEventListener('blur', () => {
    const v = targetInput.value.trim();
    if (v && !USERNAME_RE.test(v)) fTarget.setError('Invalid username: 3 to 20 characters, letters, digits and _ only.');
  });
  offenseSelect.addEventListener('change', () => {
    fOffense.setError('');
    state.jailTouched = false;
    if (!existing) state.actionTouched = false;
    updateVisibility();
    refreshRec();
  });
  orderSelect.addEventListener('change', () => {
    if (orderSelect.value !== 'hicom_isb_order') state.actionTouched = Boolean(existing);
    updateVisibility();
    refreshRec();
  });
  occurredInput.addEventListener('change', refreshRecSoon);
  actionSelect.addEventListener('change', () => { state.actionTouched = true; fAction.setError(''); updateVisibility(); });
  jailInput.addEventListener('input', () => { state.jailTouched = true; });
  ttRadios.forEach((t) => t.r.addEventListener('change', () => fTargetType.setError('')));

  updateVisibility();
  renderReco();
  refreshRec();

  // ---------------------------------------------------------------- submit

  function validate() {
    const allFields = [fTarget, fOffense, fTargetType, fOccurred, fOrderedBy, fAction, fJail, fOverride, fApprover, fLocation, fNotes, fEvidence];
    allFields.forEach((f) => f.setError(''));
    const errors = [];
    const fail = (f, msg) => { f.setError(msg); errors.push(msg); };

    const offense = currentOffense();
    const action = actionSelect.value;
    const order = orderSelect.value;

    if (!USERNAME_RE.test(targetInput.value.trim())) fail(fTarget, 'Invalid Roblox username (3 to 20 characters: letters, digits, _).');
    if (!offense) fail(fOffense, 'Choose an offense.');
    if (!getTargetType()) fail(fTargetType, 'Specify the target type.');
    if (!action) fail(fAction, 'Choose the action taken.');

    const occurred = fromLocalInput(occurredInput.value);
    if (!occurred) fail(fOccurred, 'Invalid date.');
    else if (new Date(occurred).getTime() > Date.now() + 5 * 60 * 1000) fail(fOccurred, 'The incident date cannot be in the future.');

    if (order !== 'none') {
      const by = orderedByInput.value.trim();
      if (by.length < 2 || by.length > 100) fail(fOrderedBy, 'Enter who gave the order (2 to 100 characters).');
    }
    if (JAIL_ACTIONS.has(action) && jailInput.value !== '') {
      const j = Number(jailInput.value);
      if (!Number.isInteger(j) || j < 1 || j > 86400) fail(fJail, 'Jail duration: whole number between 1 and 86400 seconds.');
    }
    const overridden = state.rec && action && action !== state.rec.recommended_action;
    const reason = overrideReason.value.trim();
    if (overridden && order === 'none' && reason.length < 3) fail(fOverride, 'Justify the override of the recommendation (3 characters minimum).');
    if (reason.length > 500) fail(fOverride, '500 characters maximum.');
    if (offense?.requires_cs_approval && action === 'arrest' && !approverSelect.value) {
      fail(fApprover, `${APPROVAL_MARK} offense: an approver (CS or above) is required for an arrest.`);
    }
    if (locationInput.value.trim().length > 120) fail(fLocation, '120 characters maximum.');
    if (notes.value.length > 4000) fail(fNotes, '4000 characters maximum.');

    const urls = [...evidenceList.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
    const badUrl = urls.find((u) => !isValidEvidenceUrl(u));
    if (badUrl) fail(fEvidence, `Invalid link (https:// required): ${badUrl.slice(0, 80)}`);
    else if (new Set(urls).size !== urls.length) fail(fEvidence, 'The same link appears more than once.');
    else if (urls.length > MAX_EVIDENCE) fail(fEvidence, `${MAX_EVIDENCE} links maximum.`);

    return { errors, urls, offense, action, order, occurred, reason };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.submitting) return;
    formError.hidden = true;
    const v = validate();
    if (v.errors.length) {
      formError.textContent = `The form has ${v.errors.length} error(s):\n• ${v.errors.join('\n• ')}`;
      formError.hidden = false;
      form.querySelector('.invalid')?.focus();
      return;
    }

    const payload = {
      target_username: targetInput.value.trim(),
      offense_id: v.offense.id,
      target_type: getTargetType(),
      action_taken: v.action,
      jail_seconds: JAIL_ACTIONS.has(v.action) && jailInput.value !== '' ? Number(jailInput.value) : null,
      override_reason: v.reason || null,
      order_type: v.order,
      ordered_by: v.order !== 'none' ? orderedByInput.value.trim() : null,
      approved_by: v.offense.requires_cs_approval && v.action === 'arrest' && approverSelect.value ? approverSelect.value : null,
      report_filed: report.input.checked,
      location: locationInput.value.trim() || null,
      occurred_at: v.occurred,
      notes: notes.value.trim() || null,
      evidence_urls: v.urls,
    };
    if (agentSelect) payload.agent_id = agentSelect.value || ctx.user.id;
    else if (!existing) payload.agent_id = ctx.user.id;

    state.submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    try {
      let id;
      if (existing) {
        const rows = unwrap(await supabase.from('sanction_logs').update(payload).eq('id', existing.id).select('id'));
        if (!rows.length) throw new Error('Update refused: you are no longer allowed to edit this log.');
        id = existing.id;
      } else {
        id = unwrap(await supabase.from('sanction_logs').insert(payload).select('id').single()).id;
      }
      location.href = link('log', { id, saved: existing ? 'updated' : 'created' });
    } catch (err) {
      formError.textContent = errorMessage(err);
      formError.hidden = false;
      formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
      state.submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = existing ? 'Save changes' : 'Save log';
    }
  });

  if (!existing && !targetInput.value) targetInput.focus();
});

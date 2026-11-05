// DOM helpers. Every piece of user data goes through textContent / setAttribute:
// innerHTML is never used with dynamic content anywhere in this project.

import { PROCEDURES, ACTIONS, STATUSES, ROLES, actionTone, APPROVAL_MARK, FIELD_LABELS } from './labels.js';
import { isValidEvidenceUrl, looksLikeImage, fmtDateTime } from './format.js';

const PROP_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'readOnly', 'required', 'multiple', 'indeterminate']);

/**
 * Creates an element.
 *   h('a', { class: 'btn', href: 'x.html', onClick: fn }, 'Texte', childNode)
 * Strings are always inserted as text nodes.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') {
        el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      } else if (key === 'text') {
        el.textContent = String(value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (PROP_KEYS.has(key)) {
        el[key] = value;
      } else if (key === 'href' || key === 'src') {
        el.setAttribute(key, safeUrl(value));
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

/** Only relative links and https URLs are allowed in href/src. */
export function safeUrl(u) {
  const s = String(u ?? '');
  if (/^https:\/\//i.test(s)) return s;
  if (/^(\.{0,2}\/)?[a-z0-9_-]+\.html([?#].*)?$/i.test(s)) return s;
  if (/^(assets|css|js)\/[a-z0-9_./-]+$/i.test(s)) return s;
  if (s.startsWith('#') || s.startsWith('?')) return s;
  return '#';
}

/** Builds "page.html?a=1&b=2" with encoded values. */
export function link(page, params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') sp.set(k, v);
  const q = sp.toString();
  return q ? `${page}?${q}` : page;
}

// ---------------------------------------------------------------- badges

export const procedureBadge = (p) =>
  h('span', { class: `badge proc proc-${p}`, title: PROCEDURES[p]?.desc ?? '' }, PROCEDURES[p]?.label ?? p);

export const actionBadge = (a, warningNumber, max) =>
  h('span', { class: `badge act act-${actionTone(a)}` },
    ACTIONS[a] ?? a,
    warningNumber ? h('span', { class: 'badge-sub' }, ` ${warningNumber}${max ? '/' + max : ''}`) : null);

export const statusBadge = (s, deleted) =>
  deleted
    ? h('span', { class: 'badge st-deleted' }, 'Deleted')
    : h('span', { class: `badge st-${s}` }, STATUSES[s] ?? s);

export const roleBadge = (r) => h('span', { class: `badge role role-${r}` }, ROLES[r] ?? r);

export const approvalMark = () =>
  h('span', { class: 'approval-mark', title: 'Approval from a Company Sergeant or above required before the arrest' }, APPROVAL_MARK);

export const flag = (text, tone = 'warn', title = '') => h('span', { class: `flag flag-${tone}`, title }, text);

// ---------------------------------------------------------------- states

export const loadingState = (text = 'Loading…') =>
  h('div', { class: 'state state-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, text));

export const emptyState = (text, ...actions) =>
  h('div', { class: 'state state-empty' }, h('p', null, text), actions.length ? h('div', { class: 'state-actions' }, actions) : null);

export function errorState(err, retry) {
  return h('div', { class: 'state state-error', role: 'alert' },
    h('strong', null, 'Error'),
    h('p', null, errorMessage(err)),
    retry ? h('button', { class: 'btn btn-ghost', type: 'button', onClick: retry }, 'Retry') : null);
}

const CONSTRAINT_MESSAGES = {
  sanction_logs_evidence_urls_check: 'Invalid evidence: 10 links maximum, https:// only.',
  sanction_logs_target_username_check: 'Invalid Roblox username (3 to 20 characters: letters, digits, _).',
  sanction_logs_notes_check: 'Notes too long (4000 characters maximum).',
  sanction_logs_location_check: 'Location too long (120 characters maximum).',
  sanction_logs_jail_seconds_check: 'Invalid jail duration (1 to 86400 seconds).',
  sanction_logs_override_reason_check: 'Invalid justification (3 to 500 characters).',
  sanction_logs_void_reason_check: 'Invalid void reason (3 to 500 characters).',
  offenses_code_check: 'Invalid code. Expected format: procedure letter + number, e.g. A15.0.',
  offenses_code_matches_procedure: 'The code letter must match the procedure (A = Alpha, F = Foxtrot, T = Tango, D = Delta, L = Lima, H = Hotel).',
  offenses_code_key: 'This offense code already exists.',
  profiles_roblox_username_lower_key: 'This Roblox username is already used by another account.',
  profiles_service_number_key: 'This service number is already assigned.',
  profiles_service_number_check: 'Invalid service number (1 to 20 characters: letters, digits, hyphen).',
  profiles_roblox_username_check: 'Invalid Roblox username (3 to 20 characters: letters, digits, _).',
  ranks_name_lower_key: 'This rank already exists.',
  squads_name_lower_key: 'This squad already exists.',
  player_aliases_alias_key: 'This alias is already linked to a player.',
};

/** Turns a Supabase / Postgres / network error into a clear message. */
export function errorMessage(err) {
  if (!err) return 'Unknown error.';
  if (typeof err === 'string') return err;
  const msg = err.message || err.error_description || String(err);
  const code = err.code;

  const constraint = /constraint "([^"]+)"/.exec(msg)?.[1] || /"([a-z_]+_key)"/.exec(msg)?.[1];
  if (constraint && CONSTRAINT_MESSAGES[constraint]) return CONSTRAINT_MESSAGES[constraint];

  if (/row-level security/i.test(msg)) return 'Action not allowed for your role.';
  if (code === '23505') return 'This value already exists (duplicate).';
  if (code === '23503' && /foreign key/i.test(msg)) return 'Item still used by other records: it cannot be deleted. Deactivate it instead.';
  if (code === 'PGRST116') return 'Item not found or not accessible.';
  if (code === 'PGRST301' || /JWT expired/i.test(msg)) return 'Session expired: please sign in again.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Cannot reach the server. Check your connection.';
  if (/Invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/Email not confirmed/i.test(msg)) return 'Email address not confirmed: click the link you received by email.';
  if (/User already registered/i.test(msg)) return 'An account already exists with this email.';
  if (/Password should be at least/i.test(msg)) return 'Password too short.';
  if (/rate limit|too many requests/i.test(msg)) return 'Too many attempts. Please wait a few minutes.';
  if (/Unable to validate email address/i.test(msg)) return 'Invalid email address.';
  return msg;
}

// ---------------------------------------------------------------- toasts

let toastRoot;
export function toast(message, tone = 'info', ms = 4500) {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  const t = h('div', { class: `toast toast-${tone}`, role: tone === 'error' ? 'alert' : 'status' }, message);
  toastRoot.append(t);
  setTimeout(() => {
    t.classList.add('toast-out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ---------------------------------------------------------------- dialogs

/**
 * Generic modal. `onSubmit` returns true (or a value) to close; throwing shows the error in the dialog.
 * Resolves with the onSubmit result, or null when cancelled.
 */
export function formDialog({ title, body, submitLabel = 'Confirm', danger = false, onSubmit, wide = false }) {
  return new Promise((resolve) => {
    const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const submitBtn = h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}` }, submitLabel);
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancel');
    const form = h('form', { class: 'dialog-form', novalidate: true },
      h('header', { class: 'dialog-head' }, h('h2', null, title)),
      h('div', { class: 'dialog-body' }, body, errorBox),
      h('footer', { class: 'dialog-foot' }, cancelBtn, submitBtn));
    const dlg = h('dialog', { class: ['dialog', wide && 'dialog-wide'] }, form);
    document.body.append(dlg);

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    cancelBtn.addEventListener('click', () => close(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      submitBtn.disabled = true;
      try {
        const result = onSubmit ? await onSubmit() : true;
        if (result !== false && result !== undefined) close(result);
      } catch (err) {
        errorBox.textContent = errorMessage(err);
        errorBox.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });
    dlg.showModal();
    const first = form.querySelector('input:not([type=hidden]), textarea, select');
    if (first) first.focus();
  });
}

/**
 * Confirmation, optionally with a reason field and/or a word to type.
 * Resolves with { value } when confirmed, null otherwise.
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, reason = null, typeToConfirm = null }) {
  const reasonInput = reason
    ? h('textarea', { class: 'input', rows: 3, maxlength: reason.maxLength ?? 500, placeholder: reason.placeholder ?? '' })
    : null;
  const typeInput = typeToConfirm ? h('input', { class: 'input', type: 'text', autocomplete: 'off' }) : null;
  const body = h('div', null,
    message ? h('p', { class: 'dialog-message' }, message) : null,
    reasonInput ? field(reason.label ?? 'Reason', reasonInput, reason.hint) : null,
    typeInput ? field(`Type "${typeToConfirm}" to confirm`, typeInput) : null);
  return formDialog({
    title, body, submitLabel: confirmLabel, danger,
    onSubmit: async () => {
      const value = reasonInput ? reasonInput.value.trim() : '';
      if (reasonInput && value.length < (reason.minLength ?? 3)) {
        throw new Error(`${reason.label ?? 'Reason'}: ${reason.minLength ?? 3} characters minimum.`);
      }
      if (typeInput && typeInput.value.trim() !== typeToConfirm) throw new Error('The confirmation text does not match.');
      return { value };
    },
  });
}

// ---------------------------------------------------------------- forms

let fieldSeq = 0;
/** Label + control + hint + inline error slot. */
export function field(label, control, hint, { required = false, className = '' } = {}) {
  const id = control.id || `f${++fieldSeq}`;
  control.id = id;
  const err = h('div', { class: 'field-error', hidden: true });
  const wrap = h('div', { class: ['field', className] },
    h('label', { for: id, class: 'field-label' }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    control,
    hint ? h('div', { class: 'field-hint' }, hint) : null,
    err);
  wrap.setError = (msg) => {
    err.textContent = msg || '';
    err.hidden = !msg;
    control.classList.toggle('invalid', Boolean(msg));
    control.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  return wrap;
}

/** <select> from [{value,label}] or {value: label}. */
export function select(options, { value = '', placeholder = null, ...props } = {}) {
  const el = h('select', { class: 'input', ...props });
  if (placeholder !== null) el.append(h('option', { value: '' }, placeholder));
  const list = Array.isArray(options) ? options : Object.entries(options).map(([v, l]) => ({ value: v, label: l }));
  for (const o of list) el.append(h('option', { value: o.value, disabled: o.disabled }, o.label));
  el.value = value ?? '';
  return el;
}

export const input = (props = {}) => h('input', { class: 'input', type: 'text', ...props });

export function checkbox(label, checked = false, props = {}) {
  const box = h('input', { type: 'checkbox', checked, ...props });
  const wrap = h('label', { class: 'check' }, box, h('span', null, label));
  wrap.input = box;
  return wrap;
}

export function button(label, onClick, variant = 'ghost', props = {}) {
  return h('button', { type: 'button', class: `btn btn-${variant}`, onClick, ...props }, label);
}

/** Runs an async action with the button disabled; shows a toast on error. */
export async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(errorMessage(err), 'error', 7000);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------- tables & misc

/** Simple table. columns: [{ label, render(row) => Node|string, className, sort }] */
export function table(columns, rows, { onRowClick, rowClass, sort, onSort } = {}) {
  const thead = h('thead', null, h('tr', null, columns.map((c) => {
    const th = h('th', { class: c.className, scope: 'col' });
    if (c.sort && onSort) {
      const active = sort?.column === c.sort;
      th.append(h('button', {
        type: 'button', class: ['th-sort', active && 'active'],
        'aria-sort': active ? (sort.ascending ? 'ascending' : 'descending') : 'none',
        onClick: () => onSort(c.sort),
      }, c.label, h('span', { class: 'sort-ind', 'aria-hidden': 'true' }, active ? (sort.ascending ? ' ▲' : ' ▼') : ' ↕')));
    } else {
      th.textContent = c.label;
    }
    return th;
  })));
  const tbody = h('tbody', null, rows.map((row) => {
    const tr = h('tr', { class: [onRowClick && 'clickable', rowClass?.(row)] },
      columns.map((c) => h('td', { class: c.className, 'data-label': c.label }, c.render(row))));
    if (onRowClick) {
      tr.tabIndex = 0;
      tr.addEventListener('click', (e) => { if (!e.target.closest('a,button,input,select')) onRowClick(row, e); });
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRowClick(row, e); });
    }
    return tr;
  }));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, thead, tbody));
}

export function pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return h('div', { class: 'pagination' },
    h('span', { class: 'muted' }, `${from}–${to} of ${total}`),
    h('div', { class: 'pager' },
      button('« First', () => onPage(1), 'ghost', { disabled: page <= 1 }),
      button('‹ Prev', () => onPage(page - 1), 'ghost', { disabled: page <= 1 }),
      h('span', { class: 'pager-current' }, `Page ${page} of ${pages}`),
      button('Next ›', () => onPage(page + 1), 'ghost', { disabled: page >= pages }),
      button('Last »', () => onPage(pages), 'ghost', { disabled: page >= pages })));
}

export const card = (title, ...children) =>
  h('section', { class: 'card' }, title ? h('h2', { class: 'card-title' }, title) : null, children);

export function definitionList(items) {
  return h('dl', { class: 'dl' }, items.filter(Boolean).map(([k, v]) =>
    h('div', { class: 'dl-row' }, h('dt', null, k), h('dd', null, v ?? '—'))));
}

/** Evidence links with image previews (no-referrer, lazy). */
export function evidenceView(urls) {
  if (!urls?.length) return h('p', { class: 'muted' }, 'No evidence attached.');
  return h('div', { class: 'evidence-grid' }, urls.map((u) => {
    if (!isValidEvidenceUrl(u)) return h('div', { class: 'evidence-item' }, h('span', { class: 'muted' }, 'Invalid link'));
    const a = h('a', { href: u, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'evidence-link' });
    if (looksLikeImage(u)) {
      const img = h('img', { src: u, alt: 'Evidence preview', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => { img.replaceWith(h('span', { class: 'evidence-fallback' }, 'Preview unavailable')); });
      a.append(img);
    }
    a.append(h('span', { class: 'evidence-url' }, u));
    return h('div', { class: 'evidence-item' }, a);
  }));
}

/** Formats a raw value from audit JSON for display. */
export function displayValue(key, value, lookups = {}) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.join('\n') : '—';
  if (lookups[key] && lookups[key][value]) return lookups[key][value];
  if (/_at$/.test(key) && typeof value === 'string') return fmtDateTime(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Field-by-field diff table between two audit snapshots. */
export function diffView(oldData, newData, lookups = {}) {
  const ignore = new Set(['updated_at', 'code_number']);
  const keys = [...new Set([...Object.keys(oldData ?? {}), ...Object.keys(newData ?? {})])]
    .filter((k) => !ignore.has(k))
    .filter((k) => JSON.stringify(oldData?.[k] ?? null) !== JSON.stringify(newData?.[k] ?? null));
  if (!keys.length) return h('p', { class: 'muted' }, 'No field changed.');
  return h('table', { class: 'diff' },
    h('thead', null, h('tr', null, h('th', null, 'Field'), oldData ? h('th', null, 'Before') : null, newData ? h('th', null, 'After') : null)),
    h('tbody', null, keys.map((k) => h('tr', null,
      h('td', { class: 'diff-key' }, FIELD_LABELS[k] ?? k),
      oldData ? h('td', { class: 'diff-old' }, displayValue(k, oldData[k], lookups)) : null,
      newData ? h('td', { class: 'diff-new' }, displayValue(k, newData[k], lookups)) : null))));
}

/** Horizontal bar list: [{label, value, tone, href}] */
export function barList(items, { empty = 'No data.' } = {}) {
  if (!items.length) return h('p', { class: 'muted' }, empty);
  const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);
  return h('ul', { class: 'bars' }, items.map((i) => {
    const fill = h('span', { class: `bar-fill tone-${i.tone ?? 'cyan'}` });
    fill.style.width = `${Math.max(2, (Number(i.value) / max) * 100)}%`;
    const label = i.href ? h('a', { href: i.href }, i.label) : h('span', null, i.label);
    return h('li', { class: 'bar' },
      h('div', { class: 'bar-head' }, h('span', { class: 'bar-label' }, i.prefix ?? null, label), h('span', { class: 'bar-value' }, String(i.value))),
      h('div', { class: 'bar-track' }, fill));
  }));
}

// Members (manager): validate pending accounts, role, rank, squad, service number,
// deactivation; manage the rank list and squads.

import { supabase, unwrap } from '../supabase.js';
import { requireAuth } from '../auth.js';
import { boot, renderShell, pageHeader } from '../layout.js';
import {
  h, replace, field, select, input, checkbox, loadingState, emptyState, errorState, table,
  roleBadge, flag, button, withBusy, toast, confirmDialog, formDialog,
} from '../ui.js';
import { ROLES, USERNAME_RE } from '../labels.js';
import { fmtDateTime, fmtRelative, qs } from '../format.js';

const ASSIGNABLE_ROLES = ['trooper', 'cs', 'officer', 'manager', 'read_only', 'pending'];

boot(async () => {
  const ctx = await requireAuth({ minLevel: 5 });
  const main = renderShell(ctx, 'members');
  let tab = ['pending', 'members', 'ranks', 'squads'].includes(qs('tab')) ? qs('tab') : null;

  let data = { profiles: [], ranks: [], squads: [] };

  async function load() {
    replace(main, loadingState('Loading members…'));
    try {
      const [profiles, ranks, squads] = await Promise.all([
        supabase.from('profiles').select('*').order('created_at', { ascending: false }).then(unwrap),
        supabase.from('ranks').select('*').order('sort_order').order('name').then(unwrap),
        supabase.from('squads').select('*').order('name').then(unwrap),
      ]);
      data = { profiles, ranks, squads };
      if (!tab) tab = profiles.some((p) => p.role === 'pending' && p.active) ? 'pending' : 'members';
      render();
    } catch (err) {
      replace(main, errorState(err, load));
    }
  }

  function render() {
    const pendingCount = data.profiles.filter((p) => p.role === 'pending' && p.active).length;
    const tabs = [
      ['pending', 'Pending', pendingCount],
      ['members', 'Members', null],
      ['ranks', 'Ranks', null],
      ['squads', 'Squads', null],
    ];
    const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([key, label, count]) =>
      h('button', {
        type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(tab === key),
        onClick: () => { tab = key; history.replaceState(null, '', `members.html?tab=${key}`); render(); },
      }, label, count ? h('span', { class: 'count' }, String(count)) : null)));

    let content;
    if (tab === 'pending') content = pendingView();
    else if (tab === 'members') content = membersView();
    else if (tab === 'ranks') content = listView('ranks');
    else content = listView('squads');

    replace(main,
      pageHeader('Member management', 'Account approval, roles, ranks, service numbers and squads.'),
      tabBar, content);
  }

  const rankName = (id) => data.ranks.find((r) => r.id === id)?.name ?? '—';
  const squadName = (id) => data.squads.find((s) => s.id === id)?.name ?? '—';

  // ------------------------------------------------------------ pending
  function pendingView() {
    const list = data.profiles.filter((p) => p.role === 'pending' && p.active);
    if (!list.length) return emptyState('No accounts awaiting approval.');
    return h('div', { class: 'stack' },
      h('div', { class: 'notice' }, 'Check the Roblox username before approving. Pending accounts cannot access any data.'),
      table([
        { label: 'Roblox username', className: 'cell-strong', render: (p) => p.roblox_username ?? h('span', { class: 'muted' }, 'Not set') },
        { label: 'Signed up', className: 'nowrap', render: (p) => h('span', { title: fmtDateTime(p.created_at) }, fmtRelative(p.created_at)) },
        { label: 'ID', className: 'cell-mono small', render: (p) => p.id.slice(0, 8) },
        {
          label: '', className: 'right nowrap', render: (p) => [
            button('Approve as Trooper', () => quickValidate(p, 'trooper'), 'primary btn-sm'), ' ',
            button('Approve…', () => editMember(p), 'ghost btn-sm'), ' ',
            button('Reject', () => refuse(p), 'danger btn-sm'),
          ],
        },
      ], list));
  }

  async function quickValidate(p, role) {
    await withBusy(null, async () => {
      const rows = unwrap(await supabase.from('profiles').update({ role }).eq('id', p.id).select('id'));
      if (!rows.length) throw new Error('Update refused.');
      toast(`${p.roblox_username ?? 'Account'} approved (${ROLES[role]}).`, 'success');
      await load();
    });
  }

  async function refuse(p) {
    const r = await confirmDialog({
      title: 'Reject account',
      message: `The account "${p.roblox_username ?? p.id}" will be deactivated (it will not see anything). To delete it completely: Supabase > Authentication > Users.`,
      confirmLabel: 'Deactivate', danger: true,
    });
    if (!r) return;
    await withBusy(null, async () => {
      unwrap(await supabase.from('profiles').update({ active: false }).eq('id', p.id).select('id'));
      toast('Account deactivated.', 'success');
      await load();
    });
  }

  // ------------------------------------------------------------ members
  let memberFilter = { q: '', role: '', showInactive: false };
  function membersView() {
    const q = input({ type: 'search', placeholder: 'Username or service number', value: memberFilter.q, maxlength: 20 });
    const role = select(ROLES, { value: memberFilter.role, placeholder: 'All roles' });
    const inactive = checkbox('Show deactivated accounts', memberFilter.showInactive);
    const tableBox = h('div');

    const draw = () => {
      memberFilter = { q: q.value.trim().toLowerCase(), role: role.value, showInactive: inactive.input.checked };
      const list = data.profiles.filter((p) =>
        (memberFilter.showInactive || p.active) &&
        (!memberFilter.role || p.role === memberFilter.role) &&
        (!memberFilter.q || (p.roblox_username ?? '').toLowerCase().includes(memberFilter.q) || (p.service_number ?? '').toLowerCase().includes(memberFilter.q)));
      replace(tableBox, list.length
        ? table([
          { label: 'Roblox username', className: 'cell-strong', render: (p) => [p.roblox_username ?? h('span', { class: 'muted' }, 'Not set'), p.id === ctx.user.id ? flag('You', 'info') : null] },
          { label: 'Service no.', className: 'cell-mono', render: (p) => p.service_number ?? '—' },
          { label: 'Rank', render: (p) => rankName(p.rank_id) },
          { label: 'Squad', render: (p) => squadName(p.squad_id) },
          { label: 'Role', render: (p) => roleBadge(p.role) },
          { label: 'Status', render: (p) => (p.active ? flag('Active', 'info') : flag('Deactivated', 'danger')) },
          { label: 'Signed up', className: 'nowrap small', render: (p) => fmtDateTime(p.created_at) },
          { label: '', className: 'right', render: (p) => button('Edit', () => editMember(p), 'ghost btn-sm') },
        ], list, { rowClass: (p) => (p.active ? '' : 'row-voided') })
        : emptyState('No member matches.'));
    };
    q.addEventListener('input', draw);
    role.addEventListener('change', draw);
    inactive.input.addEventListener('change', draw);
    draw();
    return h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('div', { class: 'filters' }, field('Search', q), field('Role', role),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Status'), inactive))),
      tableBox);
  }

  async function editMember(p) {
    const isSelf = p.id === ctx.user.id;
    const username = input({ value: p.roblox_username ?? '', maxlength: 20 });
    const service = input({ value: p.service_number ?? '', maxlength: 20, placeholder: 'e.g. CST-0420' });
    const role = select(ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLES[r] })), { value: p.role === 'pending' ? 'trooper' : p.role });
    const rank = select(data.ranks.filter((r) => r.active || r.id === p.rank_id).map((r) => ({ value: r.id, label: r.name })), { value: p.rank_id ?? '', placeholder: '— None —' });
    const squad = select(data.squads.filter((s) => s.active || s.id === p.squad_id).map((s) => ({ value: s.id, label: s.name })), { value: p.squad_id ?? '', placeholder: '— None —' });
    const active = checkbox('Active account', p.active);
    const fUser = field('Roblox username', username);
    const fService = field('Service number', service, 'Letters, digits, hyphen — 20 characters max.');

    const body = h('div', { class: 'form-grid' },
      fUser, fService,
      field('Role', role, isSelf ? 'Careful: you are changing your own role.' : 'Manager: everything. Officer: logs, voiding, resets, ⧭. CS: ⧭ and their squad\'s logs. Trooper: create, own logs < 24 h.'),
      field('Rank', rank),
      field('Squad', squad, 'A CS can edit the logs of their squad members.'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Status'), active));

    const ok = await formDialog({
      title: p.role === 'pending' ? `Approve ${p.roblox_username ?? 'the account'}` : `Edit ${p.roblox_username ?? 'the member'}`,
      body, wide: true, submitLabel: 'Save',
      onSubmit: async () => {
        fUser.setError(''); fService.setError('');
        const u = username.value.trim();
        const s = service.value.trim();
        if (u && !USERNAME_RE.test(u)) { fUser.setError('Invalid username.'); throw new Error('Fix the highlighted fields.'); }
        if (s && !/^[A-Za-z0-9-]{1,20}$/.test(s)) { fService.setError('Invalid service number.'); throw new Error('Fix the highlighted fields.'); }
        if (isSelf && (role.value !== 'manager' || !active.input.checked)) {
          const c = window.confirm('You are about to remove your own manager rights. Continue?');
          if (!c) return false;
        }
        const rows = unwrap(await supabase.from('profiles').update({
          roblox_username: u || null,
          service_number: s || null,
          role: role.value,
          rank_id: rank.value || null,
          squad_id: squad.value || null,
          active: active.input.checked,
        }).eq('id', p.id).select('id'));
        if (!rows.length) throw new Error('Update refused.');
        return true;
      },
    });
    if (ok) {
      toast('Member updated.', 'success');
      if (isSelf) location.reload();
      else await load();
    }
  }

  // ------------------------------------------------------------ ranks & squads
  function listView(kind) {
    const isRanks = kind === 'ranks';
    const rows = data[kind];
    const usedBy = (id) => data.profiles.filter((p) => (isRanks ? p.rank_id : p.squad_id) === id).length;
    const add = button(isRanks ? '+ New rank' : '+ New squad', () => editItem(kind, null), 'primary');
    return h('div', { class: 'stack' },
      h('div', { class: 'row-between' },
        h('p', { class: 'muted' }, isRanks
          ? 'Ranks offered on member profiles (order = ascending hierarchy).'
          : 'Squads define which logs a CS can edit (those of their squad members).'),
        add),
      rows.length
        ? table([
          { label: 'Name', className: 'cell-strong', render: (r) => r.name },
          isRanks ? { label: 'Abbreviation', className: 'cell-mono', render: (r) => r.short_name ?? '—' } : null,
          isRanks ? { label: 'Order', className: 'right cell-mono', render: (r) => String(r.sort_order) } : null,
          { label: 'Members', className: 'right cell-mono', render: (r) => String(usedBy(r.id)) },
          { label: 'Status', render: (r) => (r.active ? flag('Active', 'info') : flag('Inactive', 'muted')) },
          {
            label: '', className: 'right nowrap', render: (r) => [
              button('Edit', () => editItem(kind, r), 'ghost btn-sm'), ' ',
              usedBy(r.id) ? null : button('Delete', () => removeItem(kind, r), 'danger btn-sm'),
            ],
          },
        ].filter(Boolean), rows, { rowClass: (r) => (r.active ? '' : 'row-voided') })
        : emptyState(isRanks ? 'No ranks.' : 'No squads.'));
  }

  async function editItem(kind, item) {
    const isRanks = kind === 'ranks';
    const name = input({ value: item?.name ?? '', maxlength: 50 });
    const short = isRanks ? input({ value: item?.short_name ?? '', maxlength: 10 }) : null;
    const order = isRanks ? input({ type: 'number', min: 0, max: 10000, step: 1, value: item?.sort_order ?? ((data.ranks.at(-1)?.sort_order ?? 0) + 10) }) : null;
    const active = checkbox('Active', item?.active ?? true);
    const fName = field('Name', name, null, { required: true });
    const ok = await formDialog({
      title: item ? `Edit ${item.name}` : (isRanks ? 'New rank' : 'New squad'),
      body: h('div', { class: 'stack', style: { gap: '12px' } }, fName,
        short ? field('Abbreviation', short) : null, order ? field('Hierarchy order', order, 'Smaller = lower rank.') : null, active),
      submitLabel: 'Save',
      onSubmit: async () => {
        const n = name.value.trim();
        if (n.length < 2 || n.length > 50) { fName.setError('2 to 50 characters.'); throw new Error('Invalid name.'); }
        const payload = { name: n, active: active.input.checked };
        if (isRanks) {
          payload.short_name = short.value.trim() || null;
          const o = Number(order.value);
          if (!Number.isInteger(o) || o < 0 || o > 10000) throw new Error('Order: whole number between 0 and 10000.');
          payload.sort_order = o;
        }
        if (item) unwrap(await supabase.from(kind).update(payload).eq('id', item.id).select('id'));
        else unwrap(await supabase.from(kind).insert(payload).select('id'));
        return true;
      },
    });
    if (ok) {
      toast('Saved.', 'success');
      await load();
    }
  }

  async function removeItem(kind, item) {
    const r = await confirmDialog({ title: `Delete ${item.name}`, message: 'Permanent deletion.', confirmLabel: 'Delete', danger: true });
    if (!r) return;
    await withBusy(null, async () => {
      unwrap(await supabase.from(kind).delete().eq('id', item.id).select('id'));
      toast('Deleted.', 'success');
      await load();
    });
  }

  await load();
});

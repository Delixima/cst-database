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
    replace(main, loadingState('Chargement des membres…'));
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
      ['pending', 'En attente', pendingCount],
      ['members', 'Membres', null],
      ['ranks', 'Grades', null],
      ['squads', 'Équipes', null],
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
      pageHeader('Gestion des membres', 'Validation des comptes, rôles, grades, matricules et équipes.'),
      tabBar, content);
  }

  const rankName = (id) => data.ranks.find((r) => r.id === id)?.name ?? '—';
  const squadName = (id) => data.squads.find((s) => s.id === id)?.name ?? '—';

  // ------------------------------------------------------------ pending
  function pendingView() {
    const list = data.profiles.filter((p) => p.role === 'pending' && p.active);
    if (!list.length) return emptyState('Aucun compte en attente de validation.');
    return h('div', { class: 'stack' },
      h('div', { class: 'notice' }, 'Vérifiez le pseudo Roblox avant de valider. Les comptes en attente n’ont accès à aucune donnée.'),
      table([
        { label: 'Pseudo Roblox', className: 'cell-strong', render: (p) => p.roblox_username ?? h('span', { class: 'muted' }, 'Non renseigné') },
        { label: 'Inscription', className: 'nowrap', render: (p) => h('span', { title: fmtDateTime(p.created_at) }, fmtRelative(p.created_at)) },
        { label: 'Identifiant', className: 'cell-mono small', render: (p) => p.id.slice(0, 8) },
        {
          label: '', className: 'right nowrap', render: (p) => [
            button('Valider comme Trooper', () => quickValidate(p, 'trooper'), 'primary btn-sm'), ' ',
            button('Valider…', () => editMember(p), 'ghost btn-sm'), ' ',
            button('Refuser', () => refuse(p), 'danger btn-sm'),
          ],
        },
      ], list));
  }

  async function quickValidate(p, role) {
    await withBusy(null, async () => {
      const rows = unwrap(await supabase.from('profiles').update({ role }).eq('id', p.id).select('id'));
      if (!rows.length) throw new Error('Modification refusée.');
      toast(`${p.roblox_username ?? 'Compte'} validé (${ROLES[role]}).`, 'success');
      await load();
    });
  }

  async function refuse(p) {
    const r = await confirmDialog({
      title: 'Refuser le compte',
      message: `Le compte « ${p.roblox_username ?? p.id} » sera désactivé (il ne pourra rien voir). Pour le supprimer complètement : Supabase > Authentication > Users.`,
      confirmLabel: 'Désactiver', danger: true,
    });
    if (!r) return;
    await withBusy(null, async () => {
      unwrap(await supabase.from('profiles').update({ active: false }).eq('id', p.id).select('id'));
      toast('Compte désactivé.', 'success');
      await load();
    });
  }

  // ------------------------------------------------------------ members
  let memberFilter = { q: '', role: '', showInactive: false };
  function membersView() {
    const q = input({ type: 'search', placeholder: 'Pseudo ou matricule', value: memberFilter.q, maxlength: 20 });
    const role = select(ROLES, { value: memberFilter.role, placeholder: 'Tous les rôles' });
    const inactive = checkbox('Afficher les comptes désactivés', memberFilter.showInactive);
    const tableBox = h('div');

    const draw = () => {
      memberFilter = { q: q.value.trim().toLowerCase(), role: role.value, showInactive: inactive.input.checked };
      const list = data.profiles.filter((p) =>
        (memberFilter.showInactive || p.active) &&
        (!memberFilter.role || p.role === memberFilter.role) &&
        (!memberFilter.q || (p.roblox_username ?? '').toLowerCase().includes(memberFilter.q) || (p.service_number ?? '').toLowerCase().includes(memberFilter.q)));
      replace(tableBox, list.length
        ? table([
          { label: 'Pseudo Roblox', className: 'cell-strong', render: (p) => [p.roblox_username ?? h('span', { class: 'muted' }, 'Non renseigné'), p.id === ctx.user.id ? flag('Vous', 'info') : null] },
          { label: 'Matricule', className: 'cell-mono', render: (p) => p.service_number ?? '—' },
          { label: 'Grade', render: (p) => rankName(p.rank_id) },
          { label: 'Équipe', render: (p) => squadName(p.squad_id) },
          { label: 'Rôle', render: (p) => roleBadge(p.role) },
          { label: 'Statut', render: (p) => (p.active ? flag('Actif', 'info') : flag('Désactivé', 'danger')) },
          { label: 'Inscrit', className: 'nowrap small', render: (p) => fmtDateTime(p.created_at) },
          { label: '', className: 'right', render: (p) => button('Modifier', () => editMember(p), 'ghost btn-sm') },
        ], list, { rowClass: (p) => (p.active ? '' : 'row-voided') })
        : emptyState('Aucun membre ne correspond.'));
    };
    q.addEventListener('input', draw);
    role.addEventListener('change', draw);
    inactive.input.addEventListener('change', draw);
    draw();
    return h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('div', { class: 'filters' }, field('Recherche', q), field('Rôle', role),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Statut'), inactive))),
      tableBox);
  }

  async function editMember(p) {
    const isSelf = p.id === ctx.user.id;
    const username = input({ value: p.roblox_username ?? '', maxlength: 20 });
    const service = input({ value: p.service_number ?? '', maxlength: 20, placeholder: 'ex. CST-0420' });
    const role = select(ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLES[r] })), { value: p.role === 'pending' ? 'trooper' : p.role });
    const rank = select(data.ranks.filter((r) => r.active || r.id === p.rank_id).map((r) => ({ value: r.id, label: r.name })), { value: p.rank_id ?? '', placeholder: '— Aucun —' });
    const squad = select(data.squads.filter((s) => s.active || s.id === p.squad_id).map((s) => ({ value: s.id, label: s.name })), { value: p.squad_id ?? '', placeholder: '— Aucune —' });
    const active = checkbox('Compte actif', p.active);
    const fUser = field('Pseudo Roblox', username);
    const fService = field('Matricule', service, 'Lettres, chiffres, tiret — 20 caractères max.');

    const body = h('div', { class: 'form-grid' },
      fUser, fService,
      field('Rôle', role, isSelf ? 'Attention : vous modifiez votre propre rôle.' : 'Gérant : tout. Officier : logs, annulation, RAZ, ⧭. CS : ⧭ et logs de son équipe. Trooper : création, ses logs < 24 h.'),
      field('Grade', rank),
      field('Équipe', squad, 'Un CS peut modifier les logs des membres de son équipe.'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Statut'), active));

    const ok = await formDialog({
      title: p.role === 'pending' ? `Valider ${p.roblox_username ?? 'le compte'}` : `Modifier ${p.roblox_username ?? 'le membre'}`,
      body, wide: true, submitLabel: 'Enregistrer',
      onSubmit: async () => {
        fUser.setError(''); fService.setError('');
        const u = username.value.trim();
        const s = service.value.trim();
        if (u && !USERNAME_RE.test(u)) { fUser.setError('Pseudo invalide.'); throw new Error('Corrigez les champs signalés.'); }
        if (s && !/^[A-Za-z0-9-]{1,20}$/.test(s)) { fService.setError('Matricule invalide.'); throw new Error('Corrigez les champs signalés.'); }
        if (isSelf && (role.value !== 'manager' || !active.input.checked)) {
          const c = window.confirm('Vous allez retirer vos propres droits de gérant. Continuer ?');
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
        if (!rows.length) throw new Error('Modification refusée.');
        return true;
      },
    });
    if (ok) {
      toast('Membre mis à jour.', 'success');
      if (isSelf) location.reload();
      else await load();
    }
  }

  // ------------------------------------------------------------ ranks & squads
  function listView(kind) {
    const isRanks = kind === 'ranks';
    const rows = data[kind];
    const usedBy = (id) => data.profiles.filter((p) => (isRanks ? p.rank_id : p.squad_id) === id).length;
    const add = button(isRanks ? '+ Nouveau grade' : '+ Nouvelle équipe', () => editItem(kind, null), 'primary');
    return h('div', { class: 'stack' },
      h('div', { class: 'row-between' },
        h('p', { class: 'muted' }, isRanks
          ? 'Liste des grades proposés dans les fiches membres (ordre = hiérarchie croissante).'
          : 'Les équipes servent au droit de modification des CS sur les logs de leurs membres.'),
        add),
      rows.length
        ? table([
          { label: 'Nom', className: 'cell-strong', render: (r) => r.name },
          isRanks ? { label: 'Abréviation', className: 'cell-mono', render: (r) => r.short_name ?? '—' } : null,
          isRanks ? { label: 'Ordre', className: 'right cell-mono', render: (r) => String(r.sort_order) } : null,
          { label: 'Membres', className: 'right cell-mono', render: (r) => String(usedBy(r.id)) },
          { label: 'Statut', render: (r) => (r.active ? flag('Actif', 'info') : flag('Désactivé', 'muted')) },
          {
            label: '', className: 'right nowrap', render: (r) => [
              button('Modifier', () => editItem(kind, r), 'ghost btn-sm'), ' ',
              usedBy(r.id) ? null : button('Supprimer', () => removeItem(kind, r), 'danger btn-sm'),
            ],
          },
        ].filter(Boolean), rows, { rowClass: (r) => (r.active ? '' : 'row-voided') })
        : emptyState(isRanks ? 'Aucun grade.' : 'Aucune équipe.'));
  }

  async function editItem(kind, item) {
    const isRanks = kind === 'ranks';
    const name = input({ value: item?.name ?? '', maxlength: 50 });
    const short = isRanks ? input({ value: item?.short_name ?? '', maxlength: 10 }) : null;
    const order = isRanks ? input({ type: 'number', min: 0, max: 10000, step: 1, value: item?.sort_order ?? ((data.ranks.at(-1)?.sort_order ?? 0) + 10) }) : null;
    const active = checkbox('Actif', item?.active ?? true);
    const fName = field('Nom', name, null, { required: true });
    const ok = await formDialog({
      title: item ? `Modifier ${item.name}` : (isRanks ? 'Nouveau grade' : 'Nouvelle équipe'),
      body: h('div', { class: 'stack', style: { gap: '12px' } }, fName,
        short ? field('Abréviation', short) : null, order ? field('Ordre hiérarchique', order, 'Plus petit = grade le plus bas.') : null, active),
      submitLabel: 'Enregistrer',
      onSubmit: async () => {
        const n = name.value.trim();
        if (n.length < 2 || n.length > 50) { fName.setError('2 à 50 caractères.'); throw new Error('Nom invalide.'); }
        const payload = { name: n, active: active.input.checked };
        if (isRanks) {
          payload.short_name = short.value.trim() || null;
          const o = Number(order.value);
          if (!Number.isInteger(o) || o < 0 || o > 10000) throw new Error('Ordre : entier entre 0 et 10000.');
          payload.sort_order = o;
        }
        if (item) unwrap(await supabase.from(kind).update(payload).eq('id', item.id).select('id'));
        else unwrap(await supabase.from(kind).insert(payload).select('id'));
        return true;
      },
    });
    if (ok) {
      toast('Enregistré.', 'success');
      await load();
    }
  }

  async function removeItem(kind, item) {
    const r = await confirmDialog({ title: `Supprimer ${item.name}`, message: 'Suppression définitive.', confirmLabel: 'Supprimer', danger: true });
    if (!r) return;
    await withBusy(null, async () => {
      unwrap(await supabase.from(kind).delete().eq('id', item.id).select('id'));
      toast('Supprimé.', 'success');
      await load();
    });
  }

  await load();
});

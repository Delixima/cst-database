// Players: directory (player.html) and player record (player.html?u=<normalized>).
// There is no players table: everything is aggregated from the logs by normalized username.

import { supabase, unwrap } from '../supabase.js';
import { requireAuth } from '../auth.js';
import { boot, renderShell, pageHeader } from '../layout.js';
import {
  h, replace, card, field, input, loadingState, emptyState, errorState, table, pagination, link,
  procedureBadge, actionBadge, statusBadge, approvalMark, flag, button, withBusy, toast, confirmDialog, formDialog,
} from '../ui.js';
import { PROCEDURE_KEYS, TARGET_TYPES, USERNAME_RE } from '../labels.js';
import { qs, fmtDateTime, fmtRelative, escapeLike } from '../format.js';
import { PAGE_SIZE } from '../../config.js';

boot(async () => {
  const ctx = await requireAuth({ minLevel: 1 });
  const main = renderShell(ctx, 'players');
  const raw = qs('u');
  if (raw) {
    const u = raw.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(u)) {
      replace(main, errorState('Invalid username.'));
      return;
    }
    await playerRecord(ctx, main, u);
  } else {
    await directory(ctx, main);
  }
});

// =====================================================================
// Directory
// =====================================================================
async function directory(ctx, main) {
  const sp = new URLSearchParams(location.search);
  const state = { q: sp.get('q') ?? '', page: Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1) };
  const search = input({ type: 'search', value: state.q, placeholder: 'Search a username…', maxlength: 20 });
  const form = h('form', { class: 'card', role: 'search' },
    h('div', { class: 'filters' }, field('Roblox username', search),
      h('div', { class: 'field' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search'))));
  const results = h('div');
  replace(main, pageHeader('Players', 'Records aggregated from the logs. A record exists as soon as a player has been sanctioned.'), form, results);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    state.q = search.value.trim();
    state.page = 1;
    load();
  });

  async function load() {
    history.replaceState(null, '', link('player.html', { q: state.q, page: state.page > 1 ? state.page : '' }));
    replace(results, loadingState('Loading players…'));
    try {
      let q = supabase.from('players').select('*', { count: 'exact' });
      const clean = state.q.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (clean) q = q.ilike('target_normalized', `%${escapeLike(clean)}%`);
      const from = (state.page - 1) * PAGE_SIZE;
      const res = await q.order('last_sanction_at', { ascending: false, nullsFirst: false }).range(from, from + PAGE_SIZE - 1);
      if (res.error) throw res.error;

      // An old username typed in the search: point to the current record
      let aliasHint = null;
      if (clean) {
        const al = await supabase.from('player_aliases').select('alias_normalized, canonical_normalized').ilike('alias_normalized', `%${escapeLike(clean)}%`).limit(5);
        if (al.data?.length) {
          aliasHint = h('div', { class: 'notice' }, 'Former usernames found: ',
            al.data.map((a, i) => [i ? ', ' : '', a.alias_normalized, ' → ', h('a', { href: link('player.html', { u: a.canonical_normalized }) }, a.canonical_normalized)]));
        }
      }

      if (!res.data.length) {
        replace(results, aliasHint, emptyState(clean ? 'No player matches.' : 'No player has been sanctioned yet.'));
        return;
      }
      replace(results, aliasHint,
        table([
          { label: 'Username', className: 'cell-strong', render: (p) => h('a', { href: link('player.html', { u: p.target_normalized }) }, p.last_username) },
          { label: 'Type', render: (p) => TARGET_TYPES[p.last_target_type] ?? '—' },
          { label: 'Logs', className: 'right cell-mono', render: (p) => String(p.total_logs) },
          { label: 'Warnings', className: 'right cell-mono', render: (p) => String(p.warnings) },
          { label: 'Arrests', className: 'right cell-mono', render: (p) => String(p.arrests) },
          { label: 'Terminations', className: 'right cell-mono', render: (p) => String(p.terminations) },
          { label: 'Procedures', render: (p) => procCounts(p) },
          { label: 'Last sanction', className: 'nowrap', render: (p) => h('span', { title: fmtDateTime(p.last_sanction_at) }, fmtRelative(p.last_sanction_at)) },
          { label: 'Aliases', render: (p) => (p.aliases?.length ? p.aliases.join(', ') : '—') },
        ], res.data, { onRowClick: (p) => { location.href = link('player.html', { u: p.target_normalized }); } }),
        pagination({ page: state.page, pageSize: PAGE_SIZE, total: res.count ?? 0, onPage: (p) => { state.page = p; load(); } }));
    } catch (err) {
      replace(results, errorState(err, load));
    }
  }
  await load();
}

function procCounts(p) {
  const items = PROCEDURE_KEYS.filter((k) => Number(p[`${k}_count`]) > 0);
  if (!items.length) return '—';
  return h('span', { class: 'proc-counts' }, items.map((k) =>
    h('span', { class: 'proc-count' }, procedureBadge(k), h('strong', null, String(p[`${k}_count`])))));
}

// =====================================================================
// Player record
// =====================================================================
async function playerRecord(ctx, main, u) {
  async function load() {
    replace(main, loadingState('Loading the record…'));
    try {
      const alias = unwrap(await supabase.from('player_aliases').select('canonical_normalized').eq('alias_normalized', u).maybeSingle());
      if (alias) {
        location.replace(link('player.html', { u: alias.canonical_normalized }));
        return;
      }
      const [player, counters, logs, resets, aliases] = await Promise.all([
        supabase.from('players').select('*').eq('target_normalized', u).maybeSingle().then(unwrap),
        supabase.from('warning_counters').select('*').eq('target_normalized', u).order('procedure').order('code').then(unwrap),
        supabase.from('sanction_logs_expanded')
          .select('id, log_number, occurred_at, target_username, procedure, offense_id, offense_code, offense_name, offense_requires_cs_approval, offense_max_warnings, action_taken, warning_number, jail_seconds, agent_username, status, is_override, counts_for_warnings, approved_by, approval_confirmed_at')
          .eq('target_normalized', u).is('deleted_at', null).order('occurred_at', { ascending: false }).limit(500).then(unwrap),
        supabase.from('warning_resets').select('*, offense:offenses(code, name), by:profiles(roblox_username)')
          .eq('target_normalized', u).order('created_at', { ascending: false }).then(unwrap),
        supabase.from('player_aliases').select('*').eq('canonical_normalized', u).order('alias_normalized').then(unwrap),
      ]);
      render(player, counters, logs, resets, aliases);
    } catch (err) {
      replace(main, errorState(err, load));
    }
  }

  function render(player, counters, logs, resets, aliases) {
    const displayName = player?.last_username ?? u;
    const actions = [];
    if (ctx.perms.write) actions.push(h('a', { class: 'btn btn-primary', href: link('log-new.html', { u: displayName }) }, '+ New log for this player'));
    actions.push(h('a', { class: 'btn btn-ghost', href: link('logs.html', { q: u, status: 'all' }) }, 'View in logs'));
    if (ctx.perms.officer && counters.some((c) => Number(c.warnings_given) > 0)) {
      actions.push(button('Reset all warnings', () => resetWarnings(null, 'all offenses'), 'danger'));
    }

    const summary = card(null,
      h('div', { class: 'log-hero' },
        h('div', null,
          h('div', { class: 'log-number' }, displayName),
          h('div', { class: 'log-badges' },
            player?.last_target_type ? h('span', { class: 'badge role' }, TARGET_TYPES[player.last_target_type]) : null,
            procCounts(player ?? {})),
          aliases.length ? h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Former usernames: ', aliases.map((a) => a.alias_normalized).join(', ')) : null),
        h('div', { class: 'grid grid-4', style: { minWidth: 'min(420px, 100%)' } },
          stat('Logs', player?.total_logs ?? 0),
          stat('Warnings', player?.warnings ?? 0, 'warn'),
          stat('Arrests', player?.arrests ?? 0, 'danger'),
          stat('Terminations', player?.terminations ?? 0, 'danger'))),
      player ? h('p', { class: 'small muted', style: { marginTop: '10px' } },
        `First sanction: ${fmtDateTime(player.first_sanction_at)} · Last: ${fmtDateTime(player.last_sanction_at)}` +
        (Number(player.voided_logs) ? ` · ${player.voided_logs} voided log(s)` : '')) : null);

    const countersCard = card('Warning counters by offense',
      counters.length
        ? table([
          { label: 'Offense', render: (c) => [procedureBadge(c.procedure), ' ', h('span', { class: 'cell-mono' }, c.code), c.requires_cs_approval ? approvalMark() : null, h('div', { class: 'small muted' }, c.name)] },
          { label: 'Warnings', className: 'nowrap', render: (c) => counterCell(c) },
          { label: 'State', render: (c) => counterState(c) },
          { label: 'Reset', className: 'right cell-mono', render: (c) => (Number(c.warnings_reset) ? String(c.warnings_reset) : '—') },
          {
            label: '', className: 'right nowrap', render: (c) => [
              ctx.perms.write ? h('a', { class: 'btn btn-ghost btn-sm', href: link('log-new.html', { u: displayName, offense: c.code }) }, 'New log') : null,
              ctx.perms.officer && Number(c.warnings_given) > 0
                ? button('Reset', () => resetWarnings(c.offense_id, `${c.code} — ${c.name}`), 'danger btn-sm', { title: 'Reset the warnings for this offense' })
                : null,
            ],
          },
        ], counters)
        : emptyState('No counters: this player has no valid log.'));

    const resetsCard = card(`Warning resets (${resets.length})`,
      resets.length
        ? table([
          { label: 'Date', className: 'nowrap', render: (r) => fmtDateTime(r.created_at) },
          { label: 'Offense', render: (r) => (r.offense ? `${r.offense.code} — ${r.offense.name}` : 'All offenses') },
          { label: 'By', render: (r) => r.by?.roblox_username ?? '—' },
          { label: 'Reason', render: (r) => r.reason },
          { label: 'Logs affected', className: 'right cell-mono', render: (r) => String(r.logs_affected) },
        ], resets)
        : h('p', { class: 'muted' }, 'No warning resets.'));

    const logsCard = card(`Full history (${logs.length}${logs.length === 500 ? '+' : ''})`,
      logs.length
        ? table([
          { label: 'No.', className: 'cell-mono nowrap', render: (r) => r.log_number },
          { label: 'Date', className: 'nowrap', render: (r) => fmtDateTime(r.occurred_at) },
          { label: 'Username entered', render: (r) => r.target_username },
          { label: 'Offense', render: (r) => [procedureBadge(r.procedure), ' ', h('span', { class: 'cell-mono', title: r.offense_name }, r.offense_code), r.offense_requires_cs_approval ? approvalMark() : null] },
          { label: 'Action', render: (r) => actionBadge(r.action_taken, r.warning_number, r.offense_max_warnings) },
          { label: 'Jail', className: 'small nowrap', render: (r) => (r.jail_seconds ? `${r.jail_seconds} s` : '—') },
          { label: 'Agent', render: (r) => r.agent_username ?? '—' },
          { label: 'Status', render: (r) => [statusBadge(r.status), r.is_override ? flag('Override', 'warn') : null, !r.counts_for_warnings ? flag('Reset', 'muted') : null] },
        ], logs, {
          onRowClick: (r) => { location.href = link('log.html', { id: r.id }); },
          rowClass: (r) => (r.status === 'voided' ? 'row-voided' : (!r.counts_for_warnings ? 'row-reset' : '')),
        })
        : emptyState('No logs for this player.'));

    const blocks = [
      h('p', null, h('a', { href: 'player.html' }, '← Players')),
      pageHeader(`Record: ${displayName}`, 'All logs recorded under this username and its former usernames.', ...actions),
      h('div', { class: 'stack' }, summary, countersCard, logsCard, resetsCard, ctx.perms.manager ? aliasCard(aliases, displayName) : null),
    ];
    replace(main, ...blocks);
  }

  function stat(label, value, tone) {
    return h('div', { class: ['stat', tone && `tone-${tone}`] },
      h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, String(value)));
  }

  function counterCell(c) {
    const given = Number(c.warnings_given);
    const max = c.max_warnings;
    if (max === null) return `${given} (no max)`;
    if (max === 0) return '—';
    const dots = h('span', { class: 'counter-dots', 'aria-hidden': 'true' });
    for (let i = 0; i < Math.min(max, 10); i++) dots.append(h('span', { class: ['counter-dot', i < given && 'on'] }));
    return h('span', null, h('strong', { class: 'cell-mono' }, `${given} / ${max}`), ' ', dots);
  }

  function counterState(c) {
    const given = Number(c.warnings_given);
    const max = c.max_warnings;
    if (max === null) return flag('No maximum defined', 'muted');
    if (max === 0) return flag('Immediate arrest', 'danger');
    if (given >= max) return flag('Arrest authorized on next breach', 'danger');
    return flag(`Next breach: Warning ${given + 1}/${max}`, 'warn');
  }

  async function resetWarnings(offenseId, label) {
    const r = await confirmDialog({
      title: 'Reset warnings',
      message: `Player: ${u}\nOffense: ${label}\n\nExisting logs stay visible but will no longer count toward warnings. This action is recorded in the audit log.`,
      confirmLabel: 'Reset', danger: true,
      reason: { label: 'Reason', minLength: 3, maxLength: 500, placeholder: 'e.g. Manager decision, good conduct…' },
    });
    if (!r) return;
    await withBusy(null, async () => {
      const row = unwrap(await supabase.from('warning_resets')
        .insert({ target_normalized: u, offense_id: offenseId, reason: r.value })
        .select('logs_affected').single());
      toast(`Warnings reset (${row.logs_affected} log(s) affected).`, 'success');
      await load();
    });
  }

  function aliasCard(aliases, displayName) {
    const chips = aliases.length
      ? h('div', { class: 'chips' }, aliases.map((a) => h('span', { class: 'chip', title: a.note ?? '' }, a.alias_normalized,
        h('button', {
          type: 'button', 'aria-label': `Remove alias ${a.alias_normalized}`, title: 'Undo the merge',
          onClick: async () => {
            const ok = await confirmDialog({
              title: `Remove alias ${a.alias_normalized}`,
              message: `Logs entered with exactly the username "${a.alias_normalized}" will go back to a separate record.`,
              confirmLabel: 'Undo', danger: true,
            });
            if (!ok) return;
            await withBusy(null, async () => {
              const n = unwrap(await supabase.rpc('unmerge_player', { p_alias: a.alias_normalized }));
              toast(`Alias removed, ${n} log(s) moved.`, 'success');
              await load();
            });
          },
        }, '×'))))
      : h('p', { class: 'muted' }, 'No former username linked.');

    const attach = button('Link a former username', () => mergeDialog('attach', displayName), 'primary');
    const into = button('Merge this record into another username', () => mergeDialog('into', displayName), 'ghost');
    return card('Aliases and merge (manager)',
      h('p', { class: 'small muted' }, 'A Roblox player can change username. Merging combines both records; logs keep the username originally entered, and any new log entered with the former username is filed here.'),
      chips, h('div', { class: 'row', style: { marginTop: '12px' } }, attach, into));
  }

  async function mergeDialog(mode, displayName) {
    const other = input({ maxlength: 20, placeholder: 'Roblox username' });
    const note = h('textarea', { class: 'input', rows: 2, maxlength: 500, placeholder: 'e.g. Username change confirmed on…' });
    const fOther = field(mode === 'attach' ? 'Former username to link to this record' : 'Current username of the player (target record)', other, null, { required: true });
    const result = await formDialog({
      title: mode === 'attach' ? `Link a former username to ${displayName}` : `Merge ${displayName} into another record`,
      body: h('div', null,
        h('p', { class: 'dialog-message' }, mode === 'attach'
          ? 'All logs of the former username will be grouped into this record.'
          : `All logs of ${displayName} will move to the target record, and "${u}" will become an alias.`),
        fOther, field('Note', note)),
      submitLabel: 'Merge', danger: true,
      onSubmit: async () => {
        const v = other.value.trim();
        if (!USERNAME_RE.test(v)) throw new Error('Invalid Roblox username.');
        if (v.toLowerCase() === u) throw new Error('Choose a different username.');
        const params = mode === 'attach'
          ? { p_from: v, p_into: u, p_note: note.value.trim() || null }
          : { p_from: u, p_into: v, p_note: note.value.trim() || null };
        const n = unwrap(await supabase.rpc('merge_players', params));
        return { n, target: mode === 'attach' ? u : v.toLowerCase() };
      },
    });
    if (!result) return;
    toast(`Merge done: ${result.n} log(s) grouped.`, 'success');
    if (result.target !== u) location.href = link('player.html', { u: result.target });
    else await load();
  }

  await load();
}

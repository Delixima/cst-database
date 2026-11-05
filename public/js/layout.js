// Page shell: top bar, navigation, user menu, and the boot wrapper.

import { h, replace, roleBadge, errorState, toast } from './ui.js';
import { Halt, ConfigError, signOut } from './auth.js';
import { qs } from './format.js';

const NAV = [
  { key: 'dashboard', href: 'dashboard', label: 'Dashboard', min: 1 },
  { key: 'new',       href: 'log-new',   label: 'New log',         min: 2 },
  { key: 'logs',      href: 'logs',      label: 'Logs',            min: 1 },
  { key: 'players',   href: 'player',    label: 'Players',         min: 1 },
  { key: 'offenses',  href: 'offenses',  label: 'Offenses',        min: 5 },
  { key: 'members',   href: 'members',   label: 'Members',         min: 5 },
  { key: 'audit',     href: 'audit',     label: 'Audit',           min: 5 },
];

export function brand() {
  return h('a', { class: 'brand', href: 'dashboard' },
    h('img', { src: 'assets/logo.webp', alt: '', width: 36, height: 36 }),
    h('span', { class: 'brand-text' }, h('strong', null, 'CST'), h('small', null, 'Sanction registry')));
}

/** Renders the shell into #app and returns the <main> element. */
export function renderShell(ctx, active) {
  const app = document.getElementById('app');
  const nav = h('nav', { class: 'nav', id: 'main-nav', 'aria-label': 'Main navigation' },
    NAV.filter((n) => ctx.lvl >= n.min).map((n) =>
      h('a', { href: n.href, class: ['nav-link', n.key === active && 'active'], 'aria-current': n.key === active ? 'page' : null }, n.label)));

  const toggle = h('button', { type: 'button', class: 'nav-toggle', 'aria-controls': 'main-nav', 'aria-expanded': 'false' }, 'Menu');
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  const p = ctx.profile;
  const user = h('div', { class: 'user-box' },
    h('div', { class: 'user-id' },
      h('span', { class: 'user-name' }, p.roblox_username || 'No username set'),
      h('span', { class: 'user-meta' }, [p.rank?.name, p.service_number].filter(Boolean).join(' · ') || ' ')),
    roleBadge(p.role),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: signOut }, 'Sign out'));

  const main = h('main', { id: 'main', class: 'container', tabindex: '-1' });
  replace(app,
    h('a', { class: 'skip-link', href: '#main' }, 'Skip to content'),
    h('header', { class: 'topbar no-print' }, brand(), toggle, nav, user),
    main,
    h('footer', { class: 'footer no-print' }, 'Coruscant Shock Troopers — internal sanction registry. Restricted access.'));

  if (qs('denied')) toast('Access denied: this page requires a higher role.', 'error');
  return main;
}

export function pageHeader(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), subtitle ? h('p', { class: 'page-sub' }, subtitle) : null),
    actions.length ? h('div', { class: 'page-actions no-print' }, actions) : null);
}

function configErrorView() {
  return h('div', { class: 'center-screen' },
    h('div', { class: 'auth-card' }, brand(),
      h('h1', null, 'Configuration required'),
      h('p', null, 'The public/config.js file still contains the placeholder values.'),
      h('p', null, 'Fill in SUPABASE_URL and SUPABASE_ANON_KEY (the public "anon" key) from Supabase > Project Settings > API, then reload the page. See the README.')));
}

/** Runs a page entry point; renders fatal errors instead of a blank page. */
export async function boot(main) {
  try {
    await main();
  } catch (err) {
    if (err instanceof Halt) return;
    const app = document.getElementById('app');
    if (err instanceof ConfigError) {
      replace(app, configErrorView());
      return;
    }
    console.error(err);
    replace(app, h('div', { class: 'center-screen' }, h('div', { class: 'auth-card' }, brand(), errorState(err, () => location.reload()))));
  }
}

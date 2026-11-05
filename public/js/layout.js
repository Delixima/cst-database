// Page shell: top bar, navigation, user menu, and the boot wrapper.

import { h, replace, roleBadge, errorState, toast } from './ui.js';
import { Halt, ConfigError, signOut } from './auth.js';
import { qs } from './format.js';

const NAV = [
  { key: 'dashboard', href: 'dashboard.html', label: 'Tableau de bord', min: 1 },
  { key: 'new',       href: 'log-new.html',   label: 'Nouveau log',     min: 2 },
  { key: 'logs',      href: 'logs.html',      label: 'Logs',            min: 1 },
  { key: 'players',   href: 'player.html',    label: 'Joueurs',         min: 1 },
  { key: 'offenses',  href: 'offenses.html',  label: 'Infractions',     min: 5 },
  { key: 'members',   href: 'members.html',   label: 'Membres',         min: 5 },
  { key: 'audit',     href: 'audit.html',     label: 'Audit',           min: 5 },
];

export function brand() {
  return h('a', { class: 'brand', href: 'dashboard.html' },
    h('img', { src: 'assets/logo.svg', alt: '', width: 36, height: 36 }),
    h('span', { class: 'brand-text' }, h('strong', null, 'CST'), h('small', null, 'Registre des sanctions')));
}

/** Renders the shell into #app and returns the <main> element. */
export function renderShell(ctx, active) {
  const app = document.getElementById('app');
  const nav = h('nav', { class: 'nav', id: 'main-nav', 'aria-label': 'Navigation principale' },
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
      h('span', { class: 'user-name' }, p.roblox_username || 'Pseudo non renseigné'),
      h('span', { class: 'user-meta' }, [p.rank?.name, p.service_number].filter(Boolean).join(' · ') || ' ')),
    roleBadge(p.role),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: signOut }, 'Déconnexion'));

  const main = h('main', { id: 'main', class: 'container', tabindex: '-1' });
  replace(app,
    h('a', { class: 'skip-link', href: '#main' }, 'Aller au contenu'),
    h('header', { class: 'topbar no-print' }, brand(), toggle, nav, user),
    main,
    h('footer', { class: 'footer no-print' }, 'Coruscant Shock Troopers — registre interne des sanctions. Accès restreint.'));

  if (qs('denied')) toast('Accès refusé : cette page est réservée à un rôle supérieur.', 'error');
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
      h('h1', null, 'Configuration requise'),
      h('p', null, 'Le fichier public/config.js contient encore les valeurs d’exemple.'),
      h('p', null, 'Renseignez SUPABASE_URL et SUPABASE_ANON_KEY (clé publique « anon ») depuis Supabase > Project Settings > API, puis rechargez la page. Voir le README.')));
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

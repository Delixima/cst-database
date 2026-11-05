// Session, profile and permission helpers.
// The front only HIDES what a role cannot do; Postgres RLS + triggers ENFORCE it.

import { supabase, isConfigured } from './supabase.js';
import { level } from './labels.js';

/** Thrown after a redirect to stop the page script silently. */
export class Halt extends Error {}

export class ConfigError extends Error {}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*, rank:ranks(id, name, short_name), squad:squads(id, name)')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Only same-site page paths are accepted as a post-login redirect. */
export function safeNext(next) {
  if (typeof next !== 'string') return 'dashboard.html';
  const m = /^\/?([a-z0-9-]+\.html)(\?[^#\s]*)?$/i.exec(next);
  if (!m || m[1] === 'index.html') return 'dashboard.html';
  return m[1] + (m[2] ?? '');
}

/**
 * Guards a page. Redirects to the login page when not signed in, pending,
 * or deactivated; to the dashboard when the role level is too low.
 */
export async function requireAuth({ minLevel = 1 } = {}) {
  if (!isConfigured) throw new ConfigError();
  const session = await getSession();
  if (!session) {
    const here = location.pathname.split('/').pop() + location.search;
    location.replace('index.html?next=' + encodeURIComponent(here));
    throw new Halt();
  }
  const profile = await fetchProfile(session.user.id);
  if (!profile || !profile.active || level(profile.role) < 1) {
    location.replace('index.html');
    throw new Halt();
  }
  const lvl = level(profile.role);
  if (lvl < minLevel) {
    location.replace('dashboard.html?denied=1');
    throw new Halt();
  }

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.replace('index.html');
  });

  return { session, user: session.user, profile, lvl, perms: permsFor(profile) };
}

export function permsFor(profile) {
  const l = level(profile?.role);
  return {
    read: l >= 1,
    write: l >= 2,
    cs: l >= 3,
    officer: l >= 4,
    manager: l >= 5,
  };
}

/** Mirrors the update rules of the sanction_logs trigger (comfort only). */
export function canEditLog(ctx, log) {
  if (!log) return false;
  if (log.deleted_at) return ctx.lvl >= 5;
  if (ctx.lvl >= 4) return true;
  if (ctx.profile.role === 'cs') {
    return log.agent_id === ctx.user.id ||
      (log.agent_squad_id != null && log.agent_squad_id === ctx.profile.squad_id);
  }
  if (ctx.profile.role === 'trooper') {
    return log.agent_id === ctx.user.id && Date.now() - new Date(log.created_at).getTime() < 24 * 3600 * 1000;
  }
  return false;
}

export async function signOut() {
  await supabase.auth.signOut();
  location.replace('index.html');
}

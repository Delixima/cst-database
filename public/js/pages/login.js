// Login / sign-up / password reset / "account pending" screen.

import { supabase, isConfigured } from '../supabase.js';
import { ENABLE_DISCORD_LOGIN } from '../../config.js';
import { h, replace, field, input, errorMessage, toast, roleBadge } from '../ui.js';
import { boot, brand } from '../layout.js';
import { ConfigError, fetchProfile, safeNext } from '../auth.js';
import { level, USERNAME_RE } from '../labels.js';
import { qs } from '../format.js';

const app = document.getElementById('app');

function shell(...children) {
  replace(app, h('div', { class: 'center-screen' }, h('div', { class: 'auth-card' }, brand(), children)));
}

function formError() {
  return h('div', { class: 'form-error', role: 'alert', hidden: true });
}
function showError(box, err) {
  box.textContent = errorMessage(err);
  box.hidden = false;
}

// ------------------------------------------------------------------ login / signup

function authView(initialTab = 'login', notice = null) {
  const tabs = { login: null, signup: null };
  const panel = h('div');

  const tabBtn = (key, label) => {
    const b = h('button', { type: 'button', class: 'auth-tab', role: 'tab', 'aria-selected': String(key === initialTab) }, label);
    b.addEventListener('click', () => select(key));
    tabs[key] = b;
    return b;
  };

  const select = (key) => {
    for (const [k, b] of Object.entries(tabs)) b.setAttribute('aria-selected', String(k === key));
    replace(panel, key === 'login' ? loginForm() : signupForm());
  };

  shell(
    h('h1', null, 'Restricted access'),
    notice,
    h('div', { class: 'auth-tabs', role: 'tablist' }, tabBtn('login', 'Sign in'), tabBtn('signup', 'Create an account')),
    panel,
    ENABLE_DISCORD_LOGIN ? h('div', { class: 'auth-sep' }, 'or') : null,
    ENABLE_DISCORD_LOGIN ? h('button', { type: 'button', class: 'btn btn-discord btn-block', onClick: discordLogin }, 'Sign in with Discord') : null,
  );
  select(initialTab);
}

/**
 * Supabase Auth signs in with an email only. For a Roblox username, the
 * database returns the matching email only if the password is correct
 * (rate-limited), then we sign in with that email as usual.
 */
async function resolveEmail(identifier, password) {
  if (identifier.includes('@')) return { email: identifier };
  if (!USERNAME_RE.test(identifier)) return { error: 'Enter your email or your Roblox username (3 to 20 characters: letters, digits, _).' };
  const { data, error } = await supabase.rpc('resolve_login_email', { p_identifier: identifier, p_password: password });
  if (error) return { error };
  if (data?.locked) return { error: 'Too many failed attempts for this username. Try again in 15 minutes, or sign in with your email.' };
  if (!data?.email) return { error: 'Incorrect username or password.' };
  return { email: data.email };
}

function loginForm() {
  const identifier = input({ type: 'text', autocomplete: 'username', required: true, maxlength: 254, spellcheck: 'false', autocapitalize: 'none' });
  const password = input({ type: 'password', autocomplete: 'current-password', required: true });
  const err = formError();
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');
  const form = h('form', { class: 'auth-form', novalidate: true },
    field('Email or Roblox username', identifier, null, { required: true }),
    field('Password', password, null, { required: true }),
    err, submit,
    h('button', {
      type: 'button', class: 'link-btn',
      onClick: () => forgotView(identifier.value.includes('@') ? identifier.value : ''),
    }, 'Forgot your password?'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const id = identifier.value.trim();
    if (!id || !password.value) return showError(err, 'Enter your email or Roblox username, and your password.');
    submit.disabled = true;
    try {
      const resolved = await resolveEmail(id, password.value);
      if (resolved.error) return showError(err, resolved.error);
      const { error } = await supabase.auth.signInWithPassword({ email: resolved.email, password: password.value });
      if (error) return showError(err, error);
      await route();
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function signupForm() {
  const email = input({ type: 'email', autocomplete: 'email', maxlength: 254 });
  const username = input({ autocomplete: 'username', maxlength: 20, placeholder: 'e.g. Trooper_1234' });
  const password = input({ type: 'password', autocomplete: 'new-password', minlength: 8 });
  const confirm = input({ type: 'password', autocomplete: 'new-password' });
  const err = formError();
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Create my account');
  const fUser = field('Roblox username', username, '3 to 20 characters: letters, digits, _', { required: true });
  const fPass = field('Password', password, '8 characters minimum', { required: true });
  const fConfirm = field('Confirm password', confirm, null, { required: true });
  const form = h('form', { class: 'auth-form', novalidate: true },
    field('Email', email, null, { required: true }), fUser, fPass, fConfirm,
    h('p', { class: 'field-hint' }, 'Your account will stay "pending" until the CST manager approves it.'),
    err, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    [fUser, fPass, fConfirm].forEach((f) => f.setError(''));
    let bad = false;
    if (!USERNAME_RE.test(username.value.trim())) { fUser.setError('Invalid Roblox username.'); bad = true; }
    if (password.value.length < 8) { fPass.setError('8 characters minimum.'); bad = true; }
    if (password.value !== confirm.value) { fConfirm.setError('Passwords do not match.'); bad = true; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { showError(err, 'Invalid email address.'); bad = true; }
    if (bad) return;

    submit.disabled = true;
    const { data, error } = await supabase.auth.signUp({
      email: email.value.trim(),
      password: password.value,
      options: {
        data: { roblox_username: username.value.trim() },
        emailRedirectTo: new URL('index.html', location.href).href,
      },
    });
    submit.disabled = false;
    if (error) return showError(err, error);
    if (!data.session) {
      authView('login', h('div', { class: 'notice notice-ok' },
        'Account created. Confirm your address by clicking the link you received by email, then sign in.'));
      return;
    }
    await route();
  });
  return form;
}

async function discordLogin() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'discord',
    options: { redirectTo: new URL('index.html', location.href).href },
  });
  if (error) toast(errorMessage(error), 'error');
}

function forgotView(prefill = '') {
  const email = input({ type: 'email', autocomplete: 'email', value: prefill, maxlength: 254 });
  const err = formError();
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Send the link');
  const form = h('form', { class: 'auth-form', novalidate: true },
    h('p', { class: 'dim' }, 'A reset link will be sent to you by email.'),
    field('Email', email, null, { required: true }), err, submit,
    h('button', { type: 'button', class: 'link-btn', onClick: () => authView('login') }, '← Back to sign in'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!email.value.trim()) return showError(err, 'Enter your email.');
    submit.disabled = true;
    const { error } = await supabase.auth.resetPasswordForEmail(email.value.trim(), {
      redirectTo: new URL('index.html', location.href).href,
    });
    submit.disabled = false;
    if (error) return showError(err, error);
    authView('login', h('div', { class: 'notice notice-ok' }, 'If an account exists for this address, a reset email has just been sent.'));
  });
  shell(h('h1', null, 'Forgot password'), form);
}

function newPasswordView() {
  const password = input({ type: 'password', autocomplete: 'new-password' });
  const confirm = input({ type: 'password', autocomplete: 'new-password' });
  const err = formError();
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Save password');
  const form = h('form', { class: 'auth-form', novalidate: true },
    field('New password', password, '8 characters minimum', { required: true }),
    field('Confirm password', confirm, null, { required: true }), err, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (password.value.length < 8) return showError(err, 'Password: 8 characters minimum.');
    if (password.value !== confirm.value) return showError(err, 'Passwords do not match.');
    submit.disabled = true;
    const { error } = await supabase.auth.updateUser({ password: password.value });
    submit.disabled = false;
    if (error) return showError(err, error);
    toast('Password updated.', 'success');
    history.replaceState(null, '', 'index.html');
    await route();
  });
  shell(h('h1', null, 'New password'), form);
}

// ------------------------------------------------------------------ pending / inactive

function pendingView(session, profile) {
  const blocks = [];
  if (profile && !profile.active) {
    blocks.push(h('h1', null, 'Account deactivated'),
      h('div', { class: 'notice notice-danger' }, 'Your account has been deactivated. Contact the CST manager.'));
  } else {
    blocks.push(h('h1', null, 'Account pending'),
      h('div', { class: 'notice notice-warn' },
        'Your account has been created but must be approved by the CST manager. You cannot access any data until then.'));
  }

  blocks.push(h('div', { class: 'dl' },
    h('div', { class: 'dl-row' }, h('dt', null, 'Email'), h('dd', null, session.user.email ?? '—')),
    h('div', { class: 'dl-row' }, h('dt', null, 'Roblox username'), h('dd', null, profile?.roblox_username ?? 'Not set')),
    h('div', { class: 'dl-row' }, h('dt', null, 'Status'), h('dd', null, profile ? roleBadge(profile.role) : '—'))));

  if (profile && profile.active) {
    const username = input({ maxlength: 20, value: profile.roblox_username ?? '', autocomplete: 'username' });
    const fUser = field(profile.roblox_username ? 'Fix my Roblox username' : 'Set my Roblox username', username,
      'Required so the manager can identify you.');
    const err = formError();
    const save = h('button', { type: 'submit', class: 'btn btn-ghost' }, 'Save username');
    const form = h('form', { class: 'auth-form', novalidate: true }, fUser, err, save);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      fUser.setError('');
      const v = username.value.trim();
      if (!USERNAME_RE.test(v)) return fUser.setError('Invalid Roblox username (3 to 20 characters: letters, digits, _).');
      save.disabled = true;
      const { error } = await supabase.from('profiles').update({ roblox_username: v }).eq('id', session.user.id);
      save.disabled = false;
      if (error) return showError(err, error);
      toast('Username saved.', 'success');
      await route();
    });
    blocks.push(form);
  }

  blocks.push(h('div', { class: 'row-between' },
    h('button', { type: 'button', class: 'btn btn-primary', onClick: () => route() }, 'Check again'),
    h('button', { type: 'button', class: 'btn btn-ghost', onClick: async () => { await supabase.auth.signOut(); authView('login'); } }, 'Sign out')));
  shell(...blocks);
}

// ------------------------------------------------------------------ router

let recovering = false;

async function route() {
  if (recovering) return newPasswordView();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const session = data.session;
  if (!session) return authView('login');

  const profile = await fetchProfile(session.user.id);
  if (profile && profile.active && level(profile.role) >= 1) {
    location.replace(safeNext(qs('next')));
    return;
  }
  pendingView(session, profile);
}

boot(async () => {
  if (!isConfigured) throw new ConfigError();
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      recovering = true;
      newPasswordView();
    }
  });
  if (/type=recovery/.test(location.hash)) recovering = true;
  const authError = new URLSearchParams(location.hash.slice(1)).get('error_description') || qs('error_description');
  if (authError) toast(authError, 'error', 8000);
  await route();
});

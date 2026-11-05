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
    h('h1', null, 'Accès restreint'),
    notice,
    h('div', { class: 'auth-tabs', role: 'tablist' }, tabBtn('login', 'Connexion'), tabBtn('signup', 'Créer un compte')),
    panel,
    ENABLE_DISCORD_LOGIN ? h('div', { class: 'auth-sep' }, 'ou') : null,
    ENABLE_DISCORD_LOGIN ? h('button', { type: 'button', class: 'btn btn-discord btn-block', onClick: discordLogin }, 'Se connecter avec Discord') : null,
  );
  select(initialTab);
}

function loginForm() {
  const email = input({ type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
  const password = input({ type: 'password', autocomplete: 'current-password', required: true });
  const err = formError();
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Se connecter');
  const form = h('form', { class: 'auth-form', novalidate: true },
    field('Email', email, null, { required: true }),
    field('Mot de passe', password, null, { required: true }),
    err, submit,
    h('button', { type: 'button', class: 'link-btn', onClick: () => forgotView(email.value) }, 'Mot de passe oublié ?'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!email.value.trim() || !password.value) return showError(err, 'Renseignez votre email et votre mot de passe.');
    submit.disabled = true;
    const { error } = await supabase.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
    submit.disabled = false;
    if (error) return showError(err, error);
    await route();
  });
  return form;
}

function signupForm() {
  const email = input({ type: 'email', autocomplete: 'email', maxlength: 254 });
  const username = input({ autocomplete: 'username', maxlength: 20, placeholder: 'ex. Trooper_1234' });
  const password = input({ type: 'password', autocomplete: 'new-password', minlength: 8 });
  const confirm = input({ type: 'password', autocomplete: 'new-password' });
  const err = formError();
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Créer mon compte');
  const fUser = field('Pseudo Roblox', username, '3 à 20 caractères : lettres, chiffres, _', { required: true });
  const fPass = field('Mot de passe', password, '8 caractères minimum', { required: true });
  const fConfirm = field('Confirmation', confirm, null, { required: true });
  const form = h('form', { class: 'auth-form', novalidate: true },
    field('Email', email, null, { required: true }), fUser, fPass, fConfirm,
    h('p', { class: 'field-hint' }, 'Votre compte restera « en attente » jusqu’à sa validation par le gérant de la CST.'),
    err, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    [fUser, fPass, fConfirm].forEach((f) => f.setError(''));
    let bad = false;
    if (!USERNAME_RE.test(username.value.trim())) { fUser.setError('Pseudo Roblox invalide.'); bad = true; }
    if (password.value.length < 8) { fPass.setError('8 caractères minimum.'); bad = true; }
    if (password.value !== confirm.value) { fConfirm.setError('Les mots de passe ne correspondent pas.'); bad = true; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { showError(err, 'Adresse email invalide.'); bad = true; }
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
        'Compte créé. Confirmez votre adresse en cliquant sur le lien reçu par email, puis connectez-vous.'));
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
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Envoyer le lien');
  const form = h('form', { class: 'auth-form', novalidate: true },
    h('p', { class: 'dim' }, 'Un lien de réinitialisation vous sera envoyé par email.'),
    field('Email', email, null, { required: true }), err, submit,
    h('button', { type: 'button', class: 'link-btn', onClick: () => authView('login') }, '← Retour à la connexion'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!email.value.trim()) return showError(err, 'Renseignez votre email.');
    submit.disabled = true;
    const { error } = await supabase.auth.resetPasswordForEmail(email.value.trim(), {
      redirectTo: new URL('index.html', location.href).href,
    });
    submit.disabled = false;
    if (error) return showError(err, error);
    authView('login', h('div', { class: 'notice notice-ok' }, 'Si un compte existe pour cette adresse, un email de réinitialisation vient d’être envoyé.'));
  });
  shell(h('h1', null, 'Mot de passe oublié'), form);
}

function newPasswordView() {
  const password = input({ type: 'password', autocomplete: 'new-password' });
  const confirm = input({ type: 'password', autocomplete: 'new-password' });
  const err = formError();
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Enregistrer le mot de passe');
  const form = h('form', { class: 'auth-form', novalidate: true },
    field('Nouveau mot de passe', password, '8 caractères minimum', { required: true }),
    field('Confirmation', confirm, null, { required: true }), err, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (password.value.length < 8) return showError(err, 'Mot de passe : 8 caractères minimum.');
    if (password.value !== confirm.value) return showError(err, 'Les mots de passe ne correspondent pas.');
    submit.disabled = true;
    const { error } = await supabase.auth.updateUser({ password: password.value });
    submit.disabled = false;
    if (error) return showError(err, error);
    toast('Mot de passe mis à jour.', 'success');
    history.replaceState(null, '', 'index.html');
    await route();
  });
  shell(h('h1', null, 'Nouveau mot de passe'), form);
}

// ------------------------------------------------------------------ pending / inactive

function pendingView(session, profile) {
  const blocks = [];
  if (profile && !profile.active) {
    blocks.push(h('h1', null, 'Compte désactivé'),
      h('div', { class: 'notice notice-danger' }, 'Votre compte a été désactivé. Contactez le gérant de la CST.'));
  } else {
    blocks.push(h('h1', null, 'Compte en attente'),
      h('div', { class: 'notice notice-warn' },
        'Votre compte a bien été créé mais doit être validé par le gérant de la CST. Vous n’avez accès à aucune donnée en attendant.'));
  }

  blocks.push(h('div', { class: 'dl' },
    h('div', { class: 'dl-row' }, h('dt', null, 'Email'), h('dd', null, session.user.email ?? '—')),
    h('div', { class: 'dl-row' }, h('dt', null, 'Pseudo Roblox'), h('dd', null, profile?.roblox_username ?? 'Non renseigné')),
    h('div', { class: 'dl-row' }, h('dt', null, 'Statut'), h('dd', null, profile ? roleBadge(profile.role) : '—'))));

  if (profile && profile.active) {
    const username = input({ maxlength: 20, value: profile.roblox_username ?? '', autocomplete: 'username' });
    const fUser = field(profile.roblox_username ? 'Corriger mon pseudo Roblox' : 'Renseigner mon pseudo Roblox', username,
      'Indispensable pour que le gérant vous identifie.');
    const err = formError();
    const save = h('button', { type: 'submit', class: 'btn btn-ghost' }, 'Enregistrer le pseudo');
    const form = h('form', { class: 'auth-form', novalidate: true }, fUser, err, save);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      fUser.setError('');
      const v = username.value.trim();
      if (!USERNAME_RE.test(v)) return fUser.setError('Pseudo Roblox invalide (3 à 20 caractères : lettres, chiffres, _).');
      save.disabled = true;
      const { error } = await supabase.from('profiles').update({ roblox_username: v }).eq('id', session.user.id);
      save.disabled = false;
      if (error) return showError(err, error);
      toast('Pseudo enregistré.', 'success');
      await route();
    });
    blocks.push(form);
  }

  blocks.push(h('div', { class: 'row-between' },
    h('button', { type: 'button', class: 'btn btn-primary', onClick: () => route() }, 'Vérifier à nouveau'),
    h('button', { type: 'button', class: 'btn btn-ghost', onClick: async () => { await supabase.auth.signOut(); authView('login'); } }, 'Déconnexion')));
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

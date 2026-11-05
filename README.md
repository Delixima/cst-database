# CST — Registre des sanctions

Site interne de **logs des sanctions** de la CST (Coruscant Shock Troopers, police militaire de l'Empire Galactique) pour un jeu Roblox Star Wars : qui a sanctionné qui, pour quoi, quand.

Le site ne contient **ni règlement ni procédures**. La seule référence est la table des infractions (code, libellé, procédure, Jail, Warnings), qui alimente la liste déroulante et le calcul des Warnings.

- **Front** : HTML / CSS / JavaScript vanilla (ES modules), dossier `public/`, aucun build.
- **Backend** : Supabase (Postgres, Auth, Row Level Security), `supabase-js` v2 chargé depuis le CDN jsDelivr.
- **Hébergement** : Netlify, site statique, aucune Function.

---

## Sommaire

1. [Arborescence](#1-arborescence)
2. [Créer le projet Supabase](#2-créer-le-projet-supabase)
3. [Exécuter le schéma SQL](#3-exécuter-le-schéma-sql)
4. [Vérifier la sécurité (tests.sql)](#4-vérifier-la-sécurité-testssql)
5. [Configurer l'authentification](#5-configurer-lauthentification)
6. [Configurer le front (config.js)](#6-configurer-le-front-configjs)
7. [Tester en local](#7-tester-en-local)
8. [Déployer sur Netlify](#8-déployer-sur-netlify)
9. [Promouvoir le premier compte en gérant](#9-promouvoir-le-premier-compte-en-gérant)
10. [Option : connexion Discord](#10-option--connexion-discord)
11. [Rôles et droits](#11-rôles-et-droits)
12. [Calcul des Warnings](#12-calcul-des-warnings)
13. [Modèle de données](#13-modèle-de-données)
14. [Sécurité](#14-sécurité)
15. [Exploitation et dépannage](#15-exploitation-et-dépannage)

---

## 1. Arborescence

```
.
├── netlify.toml               Config Netlify (publication de public/, en-têtes de sécurité)
├── README.md
├── supabase/
│   ├── schema.sql             Tables, index, contraintes, triggers, fonctions, RLS, seed
│   └── tests.sql              Vérification des policies RLS pour chaque rôle
└── public/
    ├── index.html             Connexion / création de compte / compte en attente
    ├── dashboard.html         Tableau de bord
    ├── log-new.html           Nouveau log (et modification : ?edit=<id>)
    ├── logs.html              Liste, recherche, filtres, export CSV
    ├── log.html               Détail d'un log (?id=<id>), historique, annulation, impression
    ├── player.html            Annuaire des joueurs, fiche joueur (?u=<pseudo>)
    ├── offenses.html          Référentiel des infractions (gérant)
    ├── members.html           Gestion des membres, grades, équipes (gérant)
    ├── audit.html             Journal d'audit (gérant)
    ├── config.js              SUPABASE_URL + SUPABASE_ANON_KEY (à remplir)
    ├── assets/                logo.svg, favicon.svg
    ├── css/                   base.css, components.css, print.css
    └── js/
        ├── supabase.js        Client Supabase
        ├── auth.js            Session, profil, garde des pages, droits
        ├── layout.js          En-tête, navigation, démarrage des pages
        ├── ui.js              Helpers DOM (sans innerHTML), badges, dialogues, tableaux
        ├── labels.js          Vocabulaire métier (Alpha, Foxtrot, Warning…)
        ├── format.js          Dates, durées, validations
        ├── csv.js             Export CSV
        └── pages/             Un script par page
```

---

## 2. Créer le projet Supabase

1. Créez un compte sur <https://supabase.com>, puis **New project**.
2. Choisissez un nom (ex. `cst-sanctions`), un **mot de passe de base de données** robuste (gardez-le) et une région proche de vos joueurs (ex. `West EU (Paris)`).
3. Attendez la fin du provisionnement (1 à 2 minutes).

---

## 3. Exécuter le schéma SQL

1. Dans Supabase, ouvrez **SQL Editor** → **New query**.
2. Collez **tout** le contenu de `supabase/schema.sql`.
3. Cliquez sur **Run**.

Le script s'exécute dans une seule transaction : s'il échoue, rien n'est créé. Il est prévu pour un projet **vierge**. Pour le rejouer, supprimez d'abord les objets créés, ou recréez un projet.

Le script crée :

- les types, les tables, les index et les contraintes ;
- les triggers : numérotation `LOG-AAAA-00001`, calcul des Warnings, contrôle ⧭, droits par colonne, audit ;
- les vues `players`, `warning_counters` et `sanction_logs_expanded` ;
- les fonctions appelées par le front (`get_recommendation`, `confirm_approval`, `merge_players`, `unmerge_player`, `get_log_history`, `dashboard_stats`) ;
- les policies RLS de chaque table ;
- le seed : 4 grades et les 26 infractions du Cuff Guide (Alpha, Foxtrot, Tango, Delta). Lima et Hotel sont vides, à compléter depuis l'interface.

---

## 4. Vérifier la sécurité (tests.sql)

1. Dans **SQL Editor**, ouvrez une nouvelle requête, collez `supabase/tests.sql` et cliquez sur **Run**.
2. Le script **se termine toujours par une erreur volontaire**. C'est elle qui annule toutes les données de test (comptes, logs, remises à zéro…) : rien n'est conservé.
3. Lisez le message de cette erreur :
   - `ALL TESTS PASSED (n/n)` : toutes les policies se comportent comme prévu.
   - `TESTS FAILED (x/n)` : suivi de la liste des vérifications en échec, avec le détail.

Le script simule chaque rôle comme le fait l'API Supabase (`SET ROLE authenticated` et identifiant de l'utilisateur dans le JWT) : `anon`, `en_attente`, compte désactivé, `trooper`, `lecture_seule`, `cs`, `officier`, `gérant`.

> Relancez `tests.sql` après chaque modification du schéma.

---

## 5. Configurer l'authentification

Dans **Authentication** :

1. **Sign In / Providers → Email** : activé, avec **Confirm email** activé (recommandé).
   - Mot de passe : 8 caractères minimum (réglage *Minimum password length*).
2. **URL Configuration** :
   - **Site URL** : l'URL Netlify finale, ex. `https://cst-sanctions.netlify.app`.
   - **Redirect URLs** : ajoutez
     - `https://cst-sanctions.netlify.app/index.html`
     - `http://localhost:8080/index.html` (pour tester en local)
3. (Optionnel) **Emails** : traduisez les modèles *Confirm signup* et *Reset password* en français.
4. (Recommandé en production) **SMTP Settings** : configurez votre propre SMTP. Le SMTP intégré de Supabase est limité à quelques emails par heure.

À l'inscription, le site enregistre le pseudo Roblox dans les métadonnées. Un trigger crée alors le profil avec le rôle **en attente** (`pending`). Ce compte ne voit **rien** tant que le gérant ne l'a pas validé.

---

## 6. Configurer le front (config.js)

Dans Supabase : **Project Settings → API** (ou **API Keys**). Copiez :

- **Project URL** → `SUPABASE_URL`
- la clé **anon / publishable** (publique) → `SUPABASE_ANON_KEY`

Éditez `public/config.js` :

```js
export const SUPABASE_URL = 'https://abcdefghijkl.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
export const ENABLE_DISCORD_LOGIN = false;
export const PAGE_SIZE = 25;
```

> ⚠️ Ne mettez **jamais** la clé `service_role` / `secret` dans ce fichier ni ailleurs dans `public/`. Elle contourne toute la sécurité de la base. La clé `anon` est publique par conception : toute la sécurité repose sur RLS et les triggers.

---

## 7. Tester en local

Les modules ES exigent un serveur HTTP : ouvrir le fichier directement ne fonctionne pas. Depuis la racine du projet, lancez l'une de ces commandes :

```bash
npx serve public -l 8080
```

```bash
python -m http.server 8080 --directory public
```

Ouvrez ensuite <http://localhost:8080/index.html>.

---

## 8. Déployer sur Netlify

**Option A — dépôt Git (recommandé)**

1. Poussez le projet sur GitHub, GitLab ou Bitbucket.
2. Netlify → **Add new site → Import an existing project** → choisissez le dépôt.
3. Laissez **Build command** vide. **Publish directory** : `public` (déjà défini dans `netlify.toml`).
4. **Deploy**. Chaque push redéploie le site.

**Option B — glisser-déposer**

1. Netlify → **Add new site → Deploy manually**.
2. Glissez le dossier **`public/`**.
   - Avec cette méthode, `netlify.toml` n'est pas lu. Pour garder les en-têtes de sécurité, préférez l'option A ou la CLI : `npx netlify-cli deploy --prod --dir public` lancée depuis la racine.

**Après le premier déploiement**

- Reportez l'URL Netlify dans Supabase (**Site URL** et **Redirect URLs**, voir §5).
- Si vous utilisez un domaine personnalisé Supabase, ajoutez-le à `connect-src` dans `netlify.toml`.

---

## 9. Promouvoir le premier compte en gérant

1. Créez votre compte depuis le site (onglet **Créer un compte**) et confirmez l'email.
2. Dans Supabase **SQL Editor**, exécutez en remplaçant l'email :

```sql
update public.profiles
set role = 'manager',
    active = true
where id = (
  select id from auth.users where email = 'votre.email@exemple.com'
);
```

3. Vérifiez :

```sql
select p.roblox_username, p.role, p.active, u.email
from public.profiles p
join auth.users u on u.id = p.id
where p.role = 'manager';
```

4. Sur le site, cliquez sur **Vérifier à nouveau** (ou reconnectez-vous).

Ensuite, tout se gère depuis **Membres** : validation des comptes, rôles, grades, matricules, équipes, désactivation. Le dernier gérant actif ne peut pas être rétrogradé ni désactivé : la base le refuse.

---

## 10. Option : connexion Discord

1. Sur <https://discord.com/developers/applications> : **New Application** → **OAuth2**.
   - Copiez le **Client ID** et le **Client Secret**.
   - Dans **Redirects**, ajoutez `https://<votre-ref>.supabase.co/auth/v1/callback`.
2. Dans Supabase : **Authentication → Sign In / Providers → Discord** → activez-le et collez le Client ID et le Secret.
3. Dans `public/config.js` : `export const ENABLE_DISCORD_LOGIN = true;`
4. Les comptes Discord arrivent eux aussi **en attente**, sans pseudo Roblox. L'utilisateur le renseigne sur l'écran d'attente, et le gérant peut le corriger dans **Membres**.

---

## 11. Rôles et droits

| Rôle (UI) | Valeur SQL | Droits |
|---|---|---|
| Gérant | `manager` | Tout : comptes, référentiel, suppression (douce et définitive), journal d'audit, remise à zéro, fusion de pseudos |
| Officier | `officer` | Lire tout ; créer, modifier et annuler des logs ; logger au nom d'un agent ; remise à zéro ; confirmer les ⧭ |
| Company Sergeant | `cs` | Comme trooper, plus : approuver et confirmer les ⧭, modifier les logs de son équipe |
| Trooper | `trooper` | Créer des logs ; modifier ses propres logs de moins de 24 h ; lire tout |
| Lecture seule | `read_only` | Lire tout (sauf l'audit) |
| En attente | `pending` | Aucun accès (seulement son propre profil) |

Un compte **désactivé** (`active = false`) n'a plus aucun accès, quel que soit son rôle.

Toute la sécurité est appliquée **dans Postgres**, par RLS et des triggers. Le front se contente de masquer les boutons interdits, pour le confort.

**Infractions ⧭** : une arrestation pour une infraction ⧭ est **refusée par la base** sans approbateur actif de rôle `cs`, `officer` ou `manager`. Si l'approbateur n'est pas l'auteur du log, l'approbation apparaît comme « à confirmer ». N'importe quel CS ou supérieur la confirme depuis le tableau de bord ou le détail du log.

**Ordres** : `Arrest on Sight` et `Kill on Sight` imposent l'action recommandée. Un `Ordre HICOM / ISB` autorise n'importe quelle action sur n'importe quelle cible, et justifie l'écart. Ces trois types d'ordre exigent d'indiquer qui a donné l'ordre.

---

## 12. Calcul des Warnings

- Chaque infraction a un **maximum de Warnings** : `0` = arrestation immédiate, vide = non applicable.
- Le compteur est tenu par couple **(joueur, infraction)**. Il compte les logs valides, non supprimés et non remis à zéro qui portent un numéro de Warning.
- **Atteindre le maximum n'autorise pas l'arrestation.** Avec 3/3 déjà donnés, c'est le manquement **suivant** qui l'autorise, sans nouveau Warning.
- Delta (D1.0) : déplacement (cuff out) avec Warning numéroté, sans maximum.
- La **base recalcule tout à l'enregistrement** : numéro de Warning, action recommandée, écart. Le formulaire affiche le même calcul en direct (fonction `get_recommendation`).
- **Écart** : l'agent peut choisir une autre action que la recommandation. L'écart est alors enregistré (`is_override` et recommandation d'origine) et signalé partout. Une justification est obligatoire, sauf en cas d'ordre.
- **Remise à zéro** (officier, gérant) : depuis la fiche joueur, pour une infraction ou pour toutes. Les anciens logs restent visibles mais ne comptent plus (`counts_for_warnings = false`). L'action est tracée.

---

## 13. Modèle de données

| Table / vue | Rôle |
|---|---|
| `profiles` | Un profil par compte : pseudo Roblox, matricule, grade, équipe, rôle, actif |
| `ranks` | Liste des grades (modifiable) |
| `squads` | Équipes (portée des droits CS) |
| `offenses` | Référentiel des infractions (code, procédure, cible, Jail, Warnings max, action par défaut, ⧭, rapport) |
| `sanction_logs` | Les logs. Soft delete via `deleted_at` ; suppression définitive réservée au gérant |
| `warning_resets` | Remises à zéro (append-only) |
| `player_aliases` | Anciens pseudos → pseudo actuel (fusion) |
| `audit_log` | Journal d'audit rempli par triggers, lisible par le gérant, non modifiable même par le propriétaire |
| vue `players` | Agrégat par joueur (pas de table joueurs) |
| vue `warning_counters` | Compteurs (joueur, infraction) et état « arrestation autorisée » |
| vue `sanction_logs_expanded` | Logs avec les libellés joints (liste, export) |

**Fusion de pseudos** (gérant, fiche joueur) : les logs de l'ancien pseudo rejoignent le dossier du nouveau. Chaque log garde le pseudo saisi à l'origine. Tout nouveau log saisi avec l'ancien pseudo est classé automatiquement dans le bon dossier. Une fusion peut être défaite.

---

## 14. Sécurité

- RLS activé sur **toutes** les tables, chacune avec au moins une policy. Le rôle `anon` n'a aucun droit.
- Les règles par colonne (qui peut annuler, supprimer, réassigner, remettre à zéro, confirmer) sont appliquées par des triggers `BEFORE`.
- Les fonctions internes sont dans le schéma `private`, non exposé par l'API.
- Le front n'utilise **jamais** `innerHTML` avec des données. Tout passe par `textContent` et `setAttribute`, via le helper `h()` de `ui.js`.
- Validation côté front **et** contraintes SQL : longueurs maximales, format du pseudo Roblox, preuves en `https://` uniquement (10 au maximum), dates non futures.
- L'export CSV neutralise les formules (protection contre l'injection dans les tableurs).
- `netlify.toml` applique une CSP stricte, `X-Frame-Options: DENY`, HSTS et `noindex`.
- Les aperçus d'images de preuves sont chargés avec `referrerpolicy="no-referrer"`.

---

## 15. Exploitation et dépannage

| Symptôme | Cause / solution |
|---|---|
| Page « Configuration requise » | `public/config.js` contient encore les valeurs d'exemple |
| « Email non confirmé » | Cliquez sur le lien reçu. Sinon renvoyez-le depuis Supabase → Authentication → Users |
| Le lien de l'email mène à une erreur | La **Redirect URL** n'est pas déclarée dans Supabase (§5) |
| Compte bloqué « en attente » | Le gérant doit le valider dans **Membres** |
| « Action non autorisée pour votre rôle » | La base a refusé l'opération (RLS). Vérifiez le rôle du compte |
| Pas d'email reçu | Limite du SMTP intégré de Supabase : configurez un SMTP (§5) |
| Erreur CSP dans la console | Domaine Supabase personnalisé absent de `connect-src` (`netlify.toml`) |

**Supprimer définitivement un compte** : Supabase → Authentication → Users → *Delete user*. Si le compte a des logs (en tant qu'agent, approbateur…), la base refuse la suppression pour préserver l'historique : désactivez-le plutôt dans **Membres**.

**Sauvegardes** : les projets Supabase payants ont des sauvegardes automatiques. Sur le plan gratuit, exportez régulièrement (Database → Backups, ou `pg_dump`).

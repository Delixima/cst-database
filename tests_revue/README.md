# Tests locaux

Suite de tests qui tourne entièrement sur ta machine : Postgres en WebAssembly ([PGlite](https://pglite.dev)), avec une imitation minimale de Supabase Auth. Elle ne demande ni compte Supabase, ni connexion à la base en ligne, et n'y touche jamais.

## Lancer

Il faut Node.js 20 ou plus récent, et Git (le parcours « production » relit le schéma d'origine dans l'historique).

```bash
cd tests_revue
npm install
npm test
```

Résultat attendu :

```
PASS  tests.sql — fresh install                  ALL TESTS PASSED (128/128) …
PASS  tests.sql — production upgrade path        ALL TESTS PASSED (128/128) …
PASS  edge cases — fresh install                 ALL TESTS PASSED (60/60) …
PASS  edge cases — production upgrade path       ALL TESTS PASSED (60/60) …
PASS  front-end unit tests                       ALL 66 UNIT TESTS PASSED

ALL SUITES PASSED
```

## Ce qui est testé

| Suite | Contenu |
|---|---|
| `supabase/tests.sql` | Les policies RLS et les triggers, rôle par rôle (anon, en attente, désactivé, trooper, lecture seule, CS, officier, gérant). C'est le même fichier qu'on lance dans l'éditeur SQL de Supabase |
| `edge_body.sql` | Les cas limites et entrées hostiles : URLs piégées, longueurs, pseudos invalides, ordres HICOM/ISB, fusions en chaîne, annulation et restauration, remises à zéro, connexion par pseudo… |
| `unit.mjs` | Les fonctions JS pures du site : validation des URLs, export CSV (anti-injection de formules), filtrage des liens, redirections, messages d'erreur |

Chaque suite SQL tourne sur deux bases :
- **une installation neuve** : `supabase/schema.sql` seul ;
- **le parcours de production** : le schéma d'origine installé en ligne (commit `496e31b`), suivi de toutes les migrations de `supabase/migrations/`, dans l'ordre de leur nom. C'est ce qu'a réellement vécu ta base.

## Quand les lancer

- **Avant d'appliquer une nouvelle migration** en ligne, après l'avoir ajoutée dans `supabase/migrations/`.
- **Après toute modification** de `schema.sql`, `tests.sql` ou du code JS testé.

Règle à respecter : toute modification du schéma doit être faite **à la fois** dans `schema.sql` (installation neuve) **et** dans une nouvelle migration (base existante). Les deux parcours doivent donner le même résultat.

## Fichiers

| Fichier | Rôle |
|---|---|
| `run-all.mjs` | Lance tout (`npm test`) |
| `run-tests-sql.mjs` | Crée la base PGlite et l'imitation de Supabase, puis exécute un schéma et un fichier de tests |
| `run-edge.mjs` | Assemble les fixtures de `tests.sql` et `edge_body.sql`, puis exécute le tout |
| `edge_body.sql` | Les tests de cas limites |
| `unit.mjs` | Les tests unitaires du front |

`_prod_path.sql` et `edge.sql` sont générés à chaque lancement. Ils sont exclus de Git.

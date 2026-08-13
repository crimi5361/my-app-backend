# Migrations

Scripts de schéma, à jouer **dans l'ordre chronologique des noms**. Toutes sont
additives : elles créent des tables, des vues ou des index, et ne modifient ni ne
suppriment l'existant. Elles sont rejouables sans dommage (`CREATE ... IF NOT
EXISTS`, `CREATE OR REPLACE VIEW`, `ON CONFLICT DO NOTHING`).

La connexion est lue depuis `.env.local`, ou `.env.production` si
`NODE_ENV=production` — comme le serveur.

Le nom du fichier est donné **sans le dossier** : `run.js` le résout depuis son
propre répertoire.

```bash
node migrations/run.js 2026-08-11_module_enseignants.sql
```

## Ordre

| Fichier | Ce qu'il crée |
|---|---|
| `2026-08-11_module_enseignants.sql` | Module Enseignants : salles, besoins, offres, candidatures, contrats, trames et séances d'emploi du temps. Ajoute les rôles `charge_pedagogique`, `rh` et `enseignant`. |
| `2026-08-12_assistant_vues.sql` | Schéma `assistant` : 13 vues de lecture cloisonnées par site et par école, sans donnée personnelle. |
| `2026-08-12b_assistant_commentaires.sql` | Commentaires précisant la source de référence du chiffre d'affaires. |
| `2026-08-12c_assistant_consommation.sql` | Table de comptabilisation de la consommation du modèle. |
| `2026-08-12d_assistant_audit_utilisateurs.sql` | Vues d'audit de l'activité des agents, et table des agents exclus du périmètre. |
| `2026-08-12e_assistant_google.sql` | Rattachement OAuth du compte Google (agenda, visioconférence, messagerie). |

## Rôle de lecture de l'assistant

Après `2026-08-12_assistant_vues.sql`, créer le rôle PostgreSQL en lecture seule :

```bash
node migrations/setup-role-assistant.js
```

Le script génère un mot de passe et affiche la chaîne de connexion **une seule
fois** : elle n'est écrite dans aucun fichier versionné. La copier dans
`.env.local` et `.env.production` sous `ASSISTANT_DATABASE_URL`, puis relancer le
serveur.

Le script est rejouable — il renouvelle alors le mot de passe du rôle existant,
ce qui invalide l'ancienne chaîne de connexion.

## Variables attendues par l'assistant

```
GEMINI_API_KEY=
ASSISTANT_DATABASE_URL=          # produit par setup-role-assistant.js
ASSISTANT_BUDGET_MENSUEL_FCFA=20000
ASSISTANT_TAUX_FCFA_USD=600
```

Agenda, visioconférence et messagerie sont facultatifs : sans ces trois
variables, les outils correspondants refusent poliment et le reste fonctionne.

```
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://<domaine>/api/assistant/google/retour
```

> Le jeton Google est chiffré au repos avec une clé dérivée de `JWT_SECRET`.
> Changer `JWT_SECRET` rend les jetons illisibles et impose de refaire le
> consentement.

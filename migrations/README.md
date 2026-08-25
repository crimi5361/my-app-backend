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
| `2026-08-13_assistant_recherche_personnes.sql` | Annuaire unifié `v_personnes`, exposition du nom des étudiants, extension `unaccent`. |
| `2026-08-13b_assistant_priorite_personnes.sql` | Rang de priorité (agent avant étudiant) et resserrement de l'exclusion de l'administrateur sur les seules vues d'audit. |
| `2026-08-13c_assistant_recherche_par_mots.sql` | Recherche par mots entiers dans un ordre libre (`assistant.correspond`), avec ses index. |
| `2026-08-13d_assistant_reglages.sql` | Réglages par site : prénom de l'assistante, recherche web. |
| `2026-08-13e_assistant_voix.sql` | Voix de synthèse retenue pour la session vocale. |
| `2026-08-14_assistant_civilite.sql` | Civilité employée à l'accueil (`Monsieur` par défaut). La table `utilisateur` ne porte aucun genre : c'est la raison d'être de ce réglage. |
| `2026-08-15_documentation_base_assistante.sql` | Documentation sémantique du schéma `public` (COMMENT ON TABLE/COLUMN) pour l'assistante : rôle métier, pièges, règles de calcul (ex. `scolarite.scolarite_verse` comme référence du chiffre d'affaires, pas `paiement`). Source de vérité : `dictionnaire/*.yml`. |
| `2026-08-18_exposition_complete.sql` | Un reflet en lecture par table (`assistant.t_<table>`), cloisonné par site quand un chemin existe. Porte l'assistante de 29 à 73 tables. |
| `2026-08-18b_exposition_email_backup.sql` | Dernière table exposée. Ne restent hors d'atteinte que `etudiant.password`, `utilisateur.mot_de_passe` et `assistant_google_compte.jeton_rafraichissement`. |
| `2026-08-19_photo_disponible.sql` | Colonne `a_photo` sur `v_etudiants` : l'assistante sait enfin qui a une photo. Commentaires precisant que le personnel n'en a aucune. |
| `2026-08-19b_verrouillage_administrateur.sql` | Verrouillage COMPLET de l'administrateur : retire aussi de `v_agents`, `v_personnes` et `t_utilisateur`. Remplace la decision du 18 aout. |
| `2026-08-19c_recherche_phonetique.sql` | `assistant.phonetique()` : Koffi, Kofi, Coffi, Kauffi, Kofy et Kophi rendent tous `kofi`. Deux index GIN. |
| `2026-08-21_fiabilite_comptages.sql` | Commentaires seuls. Dit à l'assistante que `v_etudiants` porte une ligne par étudiant (donc `COUNT(*)` = effectif) et que le matricule n'est PAS une clé : 556 sur 7 208 sont inexploitables. Elle répondait « 6 620 étudiants uniques » en dédoublonnant dessus. |

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
ASSISTANT_SILENCE_MS=800         # facultatif — voir ci-dessous
```

`ASSISTANT_SILENCE_MS` est la durée de silence après laquelle l'assistante
considère que le fondateur a fini de parler. Un francophone qui hésite avant un
chiffre marque 300 à 600 ms : en dessous de 700 ms, elle coupe la phrase en deux ;
au-delà de 1200 ms, l'échange devient poussif. Ne toucher qu'en connaissance de
cause.

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

## Exclusion de l'administrateur — verrouillage complet

`assistant.agent_exclu` retire l'administrateur de la plateforme de TOUTES les
vues exposees : annuaire (`v_agents`), recherche (`v_personnes`), comptes
(`t_utilisateur`) et les deux vues d'audit. Il ne peut plus etre nomme, liste,
exporte ni agrege nominativement. Une demande le concernant recoit :
« Les informations de cet utilisateur sont protegees et ne peuvent pas etre
consultees. »

**Historique de la decision.** Le 18 aout 2026, le fondateur avait choisi de
limiter l'exclusion aux seules vues d'audit, en connaissance de cause : l'etendre
retirait 19 007 actes des totaux generaux. Le 19 aout, il a demande le
verrouillage total. La migration `2026-08-19b` applique ce second choix.

**Ce qui subsiste volontairement.** Son identifiant reste dans les colonnes
auteur (`etudiant.inscrit_par`, `paiement.effectue_par`) : l'en retirer aurait
fausse les totaux d'encaissement et d'inscription de l'etablissement. Cet
identifiant ne porte aucune donnee personnelle et ne peut plus etre resolu en
nom, puisque toutes les vues qui donnaient le nom l'excluent.

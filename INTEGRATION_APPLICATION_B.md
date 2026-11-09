# Intégration avec l'Application B (module pédagogique de l'ERP IIPEA)

Routes machine sous **`/api/integration/v1`**, réservées à l'Application B. Elles sont séparées des routes des écrans : refus par défaut, aucun jeton d'utilisateur accepté. Le contrat de référence est `docs/architecture/contrat-api-a-b.yaml` du dépôt de B (version 0.2) et son guide `CONTRAT_A_B_GUIDE.md`.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `middleware/integrationB.middleware.js` | Vérifie le jeton machine de B : JWT RS256, `kid`, émetteur, audience, `jti` jamais rejoué, scopes |
| `routes/integrationB.routes.js` | Les routes du contrat |
| `services/integrationB/ressources.js` | Correspondance tables de A → ressources du contrat (identifiants publics, minimisation, jamais de taux horaire) |
| `services/integrationB/lecture.js` | Pagination par curseur, `modifie_depuis`, filtres, ETag, effectif d'un groupe |
| `services/integrationB/evenements.js` | Réception idempotente des événements de B, accusés |
| `tests/integration_b/` | Tests (`npm run test:integration-b`), données fictives, préparation d'une base locale |

## Routes

- `GET /sante`
- Lecture (`referentiel:read`) : `/annees-academiques`, `/semestres`, `/campus`, `/ecoles`, `/departements`, `/filieres`, `/niveaux`, `/classes`, `/groupes`, `/groupes/{id}/effectif`, `/maquettes`, `/suppressions`
- Lecture (`etudiants:read`) : `/etudiants`, `/appartenances`
- Assiduité (`assiduite:read`) : `/presences?du=&au=&groupe_id=|etudiant_id=` — lit en lecture seule les tables de l'application d'assiduité de Clovis (EduCheck) dans la même base (`services/integrationB/assiduite.js`) ; `source_disponible: false` tant qu'elles n'existent pas
- Réception (scope `…:write` par type) : `POST /evenements/affectations-publiees`, `edt-publie`, `notes-validees`, `supports-publies`, `fiches-enseignants`, `campagnes-evaluation`, `service-fait-valide` ; accusé : `GET /evenements/{id_reception}`

Les événements sont enregistrés et accusés (`recu`, réponse 202). Leur intégration dans les tables de A (enseignements, emplois du temps, notes…) se branche type par type dans `services/integrationB/evenements.js` (`traitements`).

## Migration SQL à appliquer avant de déployer ce code

Comme les autres scripts du projet, la migration reste hors du dépôt : à placer dans le dossier local non versionné `migrations/integration_b/` (procédure : README, section F). Les deux fichiers sont transmis à part par l'équipe de l'Application B (Christopher Tapé) ; une copie de référence est conservée dans le dépôt de B (`docs/architecture/integration_a/`).

- `001_integration_application_b.sql` : **ajouts uniquement**, rejouable, aucune colonne existante modifiée, aucun écran touché ;
- `001_integration_application_b_annulation.sql` : retire tout ce que la migration ajoute.

Ce qu'elle ajoute : `uuid_public` et `modifie_le` (déclencheur) sur les tables lues par B ; journal des suppressions ; `maquette.version` (déclencheurs sur maquette, UE et matières) ; table `appartenance_groupe` (historique daté des groupes, alimenté par déclencheur sur `etudiant.groupe_id`, reprise de l'existant) ; tables `integration_b_evenement` et `integration_b_jeton_vu`.

## Configuration

Dans `.env.local` / `.env.production` :

```
# Fichier JSON hors dépôt : { "<kid>": "<clé publique PEM de B>" } (deux clés pendant une rotation)
CLES_PUBLIQUES_APPLICATION_B=/chemin/vers/cles-publiques-b.json
```

Retirer la clé révoque l'accès de B. A ne stocke aucun secret de B.

## Tester en local

```powershell
$env:PSQL = "chemin\vers\psql.exe"; $env:PGPASSWORD = "…"
.\tests\integration_b\preparer_base.ps1 -Schema "chemin\vers\schema_production.sql"   # pg_dump --schema-only
$env:DB_USER = "postgres"; $env:DB_PASSWORD = $env:PGPASSWORD
npm run test:integration-b
```

La base est supprimée puis recréée : le script refuse tout hôte autre que `localhost`.

## Mise en production

1. Relire la migration (ajouts uniquement) puis l'appliquer sur une **copie** de la base de production, lancer `npm run test:integration-b` sur une base locale préparée, puis l'appliquer sur Neon (production) avant de déployer le code.
2. Fusionner `integration-application-b` dans `develop_crimi`, déployer.
3. Placer le fichier des clés publiques de B (transmis par l'équipe de B, clé de **production**, différente de la clé de développement `b-dev`) hors du dépôt et renseigner `CLES_PUBLIQUES_APPLICATION_B` dans `.env.production`.
4. Vérifier : `GET /api/integration/v1/sante` répond sans jeton ; toute autre route refuse sans jeton de B (401).
5. Communiquer à l'équipe de B : l'URL publique de l'API, le `kid` enregistré, la date d'application de la migration.

## Reste à réaliser (blocs suivants, à planifier ensemble)

- Intégrer chaque type d'événement reçu dans les tables de A (`traitements` de `services/integrationB/evenements.js`) : affectations → enseignements, emplois du temps publiés, supports, fiches enseignants, notes validées (rejets motivés ligne par ligne), campagnes d'évaluation, service fait.
- Affichage dans l'espace étudiant : emploi du temps, supports, fiche enseignant, campagnes ; bouton du Délégué « Confirmer la tenue du cours » transmis à B.
- Notifications signées A → B (HMAC) vers `/integration/a/notifications/` de B : changement de groupe, d'effectif, de maquette, rejet de notes ; secret partagé à convenir.
- Délégués habilités (titulaire / suppléant, période) : n'existent pas dans A.
- Dashboard Fondateur : lecture de l'API KPI de B.

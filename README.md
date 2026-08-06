# IIPEA — Backend API

## A. Présentation du projet

Ce projet est l'API backend de la plateforme de gestion scolaire **IIPEA** (Institut International Polytechnique des Écoles Associées). Il constitue le cœur métier du système : c'est lui qui porte l'ensemble des règles académiques et financières (admissions, réinscriptions, gestion des filières/niveaux/classes/groupes, scolarité, paiements, statistiques) et qui sert de source de vérité unique pour les deux applications clientes du projet (interface agent et portail public).

**Public visé :** les équipes techniques (développeurs backend, DevOps) chargées de maintenir, faire évoluer et déployer l'API, ainsi que les développeurs frontend qui consomment ses endpoints.

## B. Technologies utilisées

| Catégorie | Choix |
|---|---|
| Langage | JavaScript (Node.js, CommonJS) |
| Framework HTTP | Express 5 |
| Base de données | PostgreSQL (accès direct via le driver `pg`, **aucun ORM** — SQL paramétré écrit à la main dans chaque contrôleur) |
| Authentification | JWT (`jsonwebtoken`) + hachage des mots de passe (`bcrypt`) |
| Génération de documents | Rendu HTML côté serveur avec le moteur de vues **EJS** (bulletins, certificats, PV, fiches — servis en HTML, sans conversion PDF côté serveur) |
| Upload de fichiers | `multer` (photos, documents justificatifs) |
| Export de données | `xlsx` (exports Excel) |
| QR codes | `qrcode` (cartes étudiant) |
| Documentation API | `swagger-jsdoc` + `swagger-ui-express` (générée à partir des annotations `@swagger` dans `routes/*.js`) |
| Sécurité applicative | `cors` (allowlist explicite), `express-rate-limit` (1000 req / 15 min sur `/api/*`) |
| Divers | `moment` (dates), `uuid`, `googleapis` |
| Outillage dev | `nodemon` (non câblé sur `npm run dev` actuellement — redémarrage manuel) |

Aucun framework de test n'est en place (`npm test` est un stub qui échoue volontairement). La CI (`.github/workflows/backend-ci.yml`) exécute `npm install` puis des étapes de lint/test avec repli silencieux (`|| echo`) — elle ne bloque donc pas la build aujourd'hui.

## C. Architecture

```
server.js                 → point d'entrée unique (malgré l'en-tête historique "app.js")
config/
  db.config.js             → pool PostgreSQL unique (bascule automatique local / Neon)
middleware/
  auth.middleware.js        → vérification JWT, alimente req.user
  authorize.middleware.js   → contrôle de rôle (authorizeRoles('admin', ...))
  upload.middleware.js       → configuration Multer (photos, documents)
  limiter.middleware.js     → rate limiting global /api/*
routes/                    → un fichier par ressource, déclare les endpoints Express + annotations Swagger
controllers/               → logique métier + requêtes SQL (une entrée par ressource ; quelques fichiers volumineux à naviguer par recherche ciblée : chargementNote.js, PV.controller.js, etudiant.controller.js, donneeespaceetudiant.controller.js)
services/                  → logique métier partagée entre plusieurs contrôleurs (ex. classeGroupe.service.js, parcoursProfessionnel.service.js, kitCampagne.service.js)
Views/                     → templates EJS des documents générés (bulletins, certificats, PV, fiches)
public/, uploads/          → fichiers statiques servis directement (`/public`, `/uploads`)
```

**Convention d'ajout d'une ressource :** créer `routes/<nom>.routes.js` + `controllers/<nom>.controller.js`, puis ajouter une entrée dans le tableau `apiRoutes` de `server.js`.

**Couches :** `routes` (Express Router + Swagger) → `controllers` (règles métier + SQL paramétré) → `config/db.config.js` (pool `pg` partagé). Il n'y a pas de couche modèle/ORM : le schéma vit uniquement dans la base PostgreSQL elle-même.

### Domaine métier (architecture V1 stabilisée)

- **Filière permanente** — une filière (`filiere`) n'est jamais recréée d'une année à l'autre ; seuls les niveaux (`niveau`), tarifs (`tarif`) et maquettes/parcours (`maquette`) sont propres à une année académique (`anneeacademique`). La préparation d'une rentrée se fait niveau par niveau, de façon progressive, jamais par duplication de filière.
- **Historisation académique unique** — `vue_position_academique` est la seule source de lecture pour toute donnée historique (effectifs, statistiques, tableaux de bord, bulletins) : elle combine la position courante (table `etudiant`) et les positions figées (`historique_inscription`, alimentée à chaque réinscription).
- **Opérations administratives exceptionnelles** — changement de filière, de parcours ou de cycle en cours d'année (hors réinscription), tracées indépendamment dans `historique_operations_admin` (jamais mélangées avec l'historisation académique par année).

## D. Communication avec les autres applications

Ce backend est **l'unique point d'accès aux données** pour les deux applications clientes du projet ; aucune des deux ne se connecte directement à la base de données.

```
┌───────────────────────┐        ┌──────────────────────────┐        ┌───────────────────────────┐
│   my-app-frontend      │  HTTP  │      my-app-backend        │  HTTP  │        IIpea               │
│  (interface agent/staff)│ ─────▶ │   (cette API — Express)    │ ◀───── │   (portail public          │
│  React + Vite, port 5173│        │   port 5000 (local) /       │        │   admissions/réinscriptions)│
└───────────────────────┘        │   défini par API_URL en prod│        │   port 8080 (local)         │
                                   └──────────────────────────┘        └───────────────────────────┘
```

- **`my-app-frontend`** (interface interne agents/staff) consomme la quasi-totalité des endpoints `/api/*` : admissions, réinscriptions, caisse, gestion des filières/niveaux/classes/groupes, statistiques, tableaux de bord, opérations administratives, etc. Authentification par JWT (`Authorization: Bearer`), un compte par membre du personnel (table `utilisateur`).
- **`IIpea`** (portail public) consomme un sous-ensemble volontairement restreint : demande d'admission en ligne, demande de réinscription en ligne, consultation des formations/tarifs publics (`controllers/public.controller.js`, `controllers/publicReinscription.controller.js`). Les dossiers créés via ce portail restent `en_attente_paiement` jusqu'à validation par le service de la Scolarité (interface agent) — aucune écriture directe sur la position académique d'un étudiant n'est possible depuis le portail public.
- **Authentification partagée** — `POST /api/auth/login` sert les deux profils : personnel (table `utilisateur`) et étudiants (table `etudiant`, `role: 'etudiant'` dans le token), selon lequel des deux comptes correspond aux identifiants fournis.
- **CORS** : allowlist explicite dans `server.js` (`corsOptions.origin`) — `http://localhost:5173`, `http://localhost:8080`, `https://myiipea.ci`, `https://www.myiipea.ci`. Toute nouvelle origine cliente (nouveau sous-domaine, nouvel environnement) doit être ajoutée ici.
- **Aucune API sortante** n'est consommée par ce backend auprès des deux autres projets — la communication est strictement entrante (frontend/portail → backend). Seule dépendance externe : Google APIs (`googleapis`, usage ponctuel).

## E. Configuration

### Variables d'environnement

Deux fichiers selon l'environnement (chargés automatiquement par `server.js` selon `NODE_ENV`) :

- `.env.local` → développement local, connexion PostgreSQL classique :
  `PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`, `JWT_SECRET`, `API_URL`
- `.env.production` → production, connexion via Neon (PostgreSQL serverless) :
  `DATABASE_URL` (endpoint pooler Neon, SSL requis), `JWT_SECRET`, `API_URL`, `PORT`

Variable optionnelle : `KIT_ANNEES_SUSPENDUES` (liste d'années académiques pour lesquelles le module kit scolaire est suspendu — voir `services/kitCampagne.service.js`).

Aucun de ces fichiers n'est versionné (`.gitignore`).

### Ports et URL

| Environnement | Port par défaut | Accès |
|---|---|---|
| Local | `5000` (variable `PORT`) | `http://localhost:5000` |
| Documentation Swagger | idem | `http://localhost:5000/api-docs` (local) / `https://myiipea.ci/api-docs` (prod) |
| Health check | idem | `GET /health` |

### Commandes

```bash
npm install       # installation des dépendances
npm run dev        # démarrage (node server.js) — pas de rechargement à chaud malgré nodemon en dépendance
npm start           # identique à dev
```

Il n'existe pas de commande de build (application Node.js exécutée directement, pas de transpilation).

## F. Déploiement

1. **Lancement local** : renseigner `.env.local`, puis `npm install && npm run dev`. Le serveur détecte automatiquement l'environnement (`NODE_ENV`) et charge le bon fichier `.env`.
2. **Mise à jour de la base** : ce projet n'utilise **aucun outil de migration formel**. Les scripts SQL de migration (dossier local `migrations/`, non versionné — voir section suivante) doivent être appliqués **manuellement**, dans l'ordre numérique, sur chaque environnement (local puis production) avant de déployer le code qui en dépend.
3. **Déploiement production** : le serveur charge `.env.production` (`NODE_ENV=production`) et bascule automatiquement sur la connexion Neon. Vérifier au préalable que toutes les migrations SQL en attente ont été appliquées sur la base de production.
4. **Mise à jour** : `git pull`, `npm install` (si dépendances modifiées), application manuelle des migrations SQL nouvelles, redémarrage du process Node.

## G. Historique de la V1

**Version : V1**

Chantier de stabilisation de l'architecture académique et financière, et mise en place des derniers outils d'administration avant mise en production :

- Architecture **filière permanente** (une filière n'est jamais recréée d'une année à l'autre) et refonte de la page de préparation de rentrée (configuration progressive des niveaux, parcours et tarifs par année).
- Fiabilisation de la création et de la réutilisation automatique des **classes** et **groupes**, y compris en parité entre les canaux agent et portail public.
- Unification de l'**historique académique** (`vue_position_academique`) : source unique pour les effectifs, statistiques et tableaux de bord, remplaçant les anciens mécanismes de calcul dispersés.
- Unification de l'**historique financier** (scolarité, paiements, kits, prises en charge) sur la même base historisée.
- Migration des **tableaux de bord** et **rapports statistiques** vers la nouvelle architecture historisée.
- Mise en place des **outils d'administration** pour les cas exceptionnels de la vie académique d'un étudiant : changement de filière, changement de parcours, changement de cycle — chacun avec vérifications métier et simulation préalable pour le changement de cycle.
- **Traçabilité complète** des opérations administratives exceptionnelles (table `historique_operations_admin` : date, utilisateur, valeurs avant/après, motif).
- Stabilisation des rapports, certificats et reçus générés sur la nouvelle architecture.

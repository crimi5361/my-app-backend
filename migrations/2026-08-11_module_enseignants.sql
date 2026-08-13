-- ============================================================================
--  Module Gestion des Enseignants (2026-08-11)
--  Cahier des charges : Espace Chargé Pédagogique + Espace Ressources Humaines
--
--  Principe : additif uniquement. Aucun ALTER ni DROP sur une table existante.
--  Le lien avec l'existant se fait par clés étrangères sortantes (filiere, niveau,
--  classe, matiere, anneeacademique, site, ecole, utilisateur, professeur).
--
--  Le nouvel enseignant est modélisé par une table dédiée `enseignant` plutôt que par
--  un enrichissement de `professeur` : `professeur` reste le référentiel minimal
--  consommé par `enseignement` / les notes, et chaque enseignant recruté y est doublé
--  (enseignant.professeur_id) pour que la chaîne d'évaluation existante continue de
--  fonctionner sans modification.
-- ============================================================================

BEGIN;

-- Nécessaire pour la contrainte d'exclusion « une salle, un créneau » (§4 du cahier
-- des charges) : elle combine une égalité sur des colonnes btree (salle_id, date) et
-- un chevauchement de plage, ce que seul un index gist mixte permet.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
--  Rôles applicatifs
-- ---------------------------------------------------------------------------
INSERT INTO role (nom, description)
SELECT 'charge_pedagogique', 'Chargé Pédagogique — besoins en enseignants, pré-validation des candidatures, emploi du temps et allocation des salles de ses filières'
WHERE NOT EXISTS (SELECT 1 FROM role WHERE nom = 'charge_pedagogique');

INSERT INTO role (nom, description)
SELECT 'rh', 'Ressources Humaines — offres, validation des candidatures, création des accès et contractualisation des enseignants'
WHERE NOT EXISTS (SELECT 1 FROM role WHERE nom = 'rh');

INSERT INTO role (nom, description)
SELECT 'enseignant', 'Enseignant — portail externe (phase ultérieure)'
WHERE NOT EXISTS (SELECT 1 FROM role WHERE nom = 'enseignant');

-- ---------------------------------------------------------------------------
--  1. Référentiel des salles physiques
--     La page /Gestion_academique/Salles existait sans table derrière ; l'allocation
--     des salles par le Chargé Pédagogique la rend indispensable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS salle (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(30)  NOT NULL,
  nom           VARCHAR(120) NOT NULL,
  site_id       INTEGER      NOT NULL REFERENCES site(id),
  batiment      VARCHAR(80),
  etage         VARCHAR(30),
  capacite      INTEGER      NOT NULL DEFAULT 0 CHECK (capacite >= 0),
  type_salle    VARCHAR(20)  NOT NULL DEFAULT 'cours'
                CHECK (type_salle IN ('cours', 'td', 'tp', 'amphi', 'labo', 'informatique')),
  equipements   TEXT,
  statut        VARCHAR(10)  NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'inactif')),
  observations  TEXT,
  created_at    TIMESTAMP    NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP    NOT NULL DEFAULT now(),
  CONSTRAINT salle_code_site_key UNIQUE (code, site_id)
);

CREATE INDEX IF NOT EXISTS idx_salle_site ON salle(site_id);

-- ---------------------------------------------------------------------------
--  2. Périmètre du Chargé Pédagogique
--     « Le CP ne gère que les filières (ex: BTS 1) qui lui sont rattachées. »
--     niveau_id NULL = toute la filière ; sinon un niveau précis de cette filière.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affectation_charge_pedagogique (
  id             SERIAL PRIMARY KEY,
  utilisateur_id INTEGER NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  filiere_id     INTEGER NOT NULL REFERENCES filiere(id),
  niveau_id      INTEGER REFERENCES niveau(id),
  affecte_par    INTEGER REFERENCES utilisateur(id),
  created_at     TIMESTAMP NOT NULL DEFAULT now()
);

-- COALESCE : deux affectations « toute la filière » (niveau_id NULL) pour le même CP
-- doivent être refusées comme un doublon, ce qu'un UNIQUE classique ne ferait pas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_affectation_cp
  ON affectation_charge_pedagogique (utilisateur_id, filiere_id, COALESCE(niveau_id, -1));

-- ---------------------------------------------------------------------------
--  3. Catalogue des besoins en enseignants (Chargé Pédagogique)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS besoin_enseignant (
  id                    SERIAL PRIMARY KEY,
  annee_academique_id   INTEGER NOT NULL REFERENCES anneeacademique(id),
  filiere_id            INTEGER NOT NULL REFERENCES filiere(id),
  niveau_id             INTEGER REFERENCES niveau(id),
  matiere_id            INTEGER REFERENCES matiere(id),
  intitule              VARCHAR(180) NOT NULL,
  specialite_attendue   VARCHAR(120),
  volume_horaire_prevu  INTEGER NOT NULL DEFAULT 0 CHECK (volume_horaire_prevu >= 0),
  nombre_postes         INTEGER NOT NULL DEFAULT 1 CHECK (nombre_postes >= 1),
  priorite              VARCHAR(10) NOT NULL DEFAULT 'normale'
                        CHECK (priorite IN ('basse', 'normale', 'haute')),
  statut                VARCHAR(10) NOT NULL DEFAULT 'ouvert'
                        CHECK (statut IN ('ouvert', 'pourvu', 'annule')),
  commentaire           TEXT,
  cree_par              INTEGER REFERENCES utilisateur(id),
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_besoin_perimetre ON besoin_enseignant(filiere_id, niveau_id, annee_academique_id);

-- ---------------------------------------------------------------------------
--  4. Offres d'emploi publiées par les RH
--     Les offres au statut 'publiee' sont exposées sans authentification au site
--     institutionnel (GET /api/public/enseignants/offres) : c'est par là que les
--     candidatures externes entrent dans le système.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offre_emploi_enseignant (
  id                       SERIAL PRIMARY KEY,
  reference                VARCHAR(30) NOT NULL UNIQUE,
  titre                    VARCHAR(180) NOT NULL,
  description              TEXT,
  specialite               VARCHAR(120),
  besoin_id                INTEGER REFERENCES besoin_enseignant(id),
  filiere_id               INTEGER REFERENCES filiere(id),
  niveau_id                INTEGER REFERENCES niveau(id),
  site_id                  INTEGER REFERENCES site(id),
  type_contrat             VARCHAR(15) NOT NULL DEFAULT 'vacataire'
                           CHECK (type_contrat IN ('vacataire', 'permanent', 'mission')),
  volume_horaire_indicatif INTEGER,
  profil_recherche         TEXT,
  date_publication         DATE,
  date_cloture             DATE,
  statut                   VARCHAR(10) NOT NULL DEFAULT 'brouillon'
                           CHECK (statut IN ('brouillon', 'publiee', 'cloturee')),
  publiee_par              INTEGER REFERENCES utilisateur(id),
  created_at               TIMESTAMP NOT NULL DEFAULT now(),
  updated_at               TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offre_statut ON offre_emploi_enseignant(statut);

-- ---------------------------------------------------------------------------
--  5. Candidatures
--     Workflow (§4) : recue → transmise_rh → validee | refusee.
--     'preselectionnee' est l'étape intermédiaire de la bannette du CP (il a lu et
--     retenu le dossier mais ne l'a pas encore transmis).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS candidature_enseignant (
  id                  SERIAL PRIMARY KEY,
  reference           VARCHAR(30) NOT NULL UNIQUE,
  nom                 VARCHAR(80)  NOT NULL,
  prenoms             VARCHAR(120) NOT NULL,
  email               VARCHAR(150) NOT NULL,
  telephone           VARCHAR(40),
  date_naissance      DATE,
  genre               VARCHAR(10) CHECK (genre IN ('M', 'F', 'Autre')),
  nationalite         VARCHAR(60),
  grade               VARCHAR(80),
  specialite          VARCHAR(120),
  annees_experience   INTEGER CHECK (annees_experience >= 0),
  cv_path             VARCHAR(255),
  cv_original_name    VARCHAR(255),
  lettre_motivation   TEXT,
  offre_id            INTEGER REFERENCES offre_emploi_enseignant(id),
  source              VARCHAR(20) NOT NULL DEFAULT 'portail_public'
                      CHECK (source IN ('portail_public', 'saisie_interne')),
  statut              VARCHAR(20) NOT NULL DEFAULT 'recue'
                      CHECK (statut IN ('recue', 'preselectionnee', 'transmise_rh', 'validee', 'refusee')),
  commentaire_cp      TEXT,
  cp_evaluateur_id    INTEGER REFERENCES utilisateur(id),
  date_prevalidation  TIMESTAMP,
  commentaire_rh      TEXT,
  motif_refus         TEXT,
  rh_valideur_id      INTEGER REFERENCES utilisateur(id),
  date_decision       TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  updated_at          TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidature_statut ON candidature_enseignant(statut);
CREATE INDEX IF NOT EXISTS idx_candidature_email  ON candidature_enseignant(lower(email));

-- Filières visées par le candidat : c'est ce qui détermine quel Chargé Pédagogique
-- voit la candidature dans sa bannette.
CREATE TABLE IF NOT EXISTS candidature_filiere (
  candidature_id INTEGER NOT NULL REFERENCES candidature_enseignant(id) ON DELETE CASCADE,
  filiere_id     INTEGER NOT NULL REFERENCES filiere(id),
  PRIMARY KEY (candidature_id, filiere_id)
);

CREATE TABLE IF NOT EXISTS candidature_diplome (
  id              SERIAL PRIMARY KEY,
  candidature_id  INTEGER NOT NULL REFERENCES candidature_enseignant(id) ON DELETE CASCADE,
  intitule        VARCHAR(180) NOT NULL,
  etablissement   VARCHAR(180),
  annee_obtention INTEGER,
  fichier_path    VARCHAR(255),
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidature_diplome ON candidature_diplome(candidature_id);

-- ---------------------------------------------------------------------------
--  6. Enseignant recruté
--     Créé par les RH à la validation d'une candidature, avec en même temps :
--       • une ligne `professeur` (compatibilité avec `enseignement` et les notes) ;
--       • une ligne `utilisateur` de rôle 'enseignant' (accès au portail externe).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enseignant (
  id               SERIAL PRIMARY KEY,
  matricule        VARCHAR(30) NOT NULL UNIQUE,
  candidature_id   INTEGER UNIQUE REFERENCES candidature_enseignant(id),
  professeur_id    INTEGER UNIQUE REFERENCES professeur(id),
  utilisateur_id   INTEGER UNIQUE REFERENCES utilisateur(id),
  nom              VARCHAR(80)  NOT NULL,
  prenoms          VARCHAR(120) NOT NULL,
  email            VARCHAR(150) NOT NULL UNIQUE,
  telephone        VARCHAR(40),
  grade            VARCHAR(80),
  specialite       VARCHAR(120),
  cv_path          VARCHAR(255),
  site_id          INTEGER REFERENCES site(id),
  ecole_id         INTEGER REFERENCES ecole(id),
  date_recrutement DATE NOT NULL DEFAULT CURRENT_DATE,
  statut           VARCHAR(10) NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'inactif')),
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
--  7. Contrat
--     Règle §4 « Contractualisation » : sans contrat actif (taux horaire + volume +
--     classes d'intervention), le Chargé Pédagogique ne peut pas planifier l'enseignant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contrat_enseignant (
  id                     SERIAL PRIMARY KEY,
  enseignant_id          INTEGER NOT NULL REFERENCES enseignant(id) ON DELETE CASCADE,
  annee_academique_id    INTEGER NOT NULL REFERENCES anneeacademique(id),
  type_contrat           VARCHAR(15) NOT NULL DEFAULT 'vacataire'
                         CHECK (type_contrat IN ('vacataire', 'permanent', 'mission')),
  taux_horaire           NUMERIC(12, 2) NOT NULL CHECK (taux_horaire >= 0),
  volume_horaire_global  INTEGER NOT NULL CHECK (volume_horaire_global >= 0),
  date_debut             DATE NOT NULL DEFAULT CURRENT_DATE,
  date_fin               DATE,
  statut                 VARCHAR(10) NOT NULL DEFAULT 'actif'
                         CHECK (statut IN ('actif', 'suspendu', 'termine')),
  observations           TEXT,
  etabli_par             INTEGER REFERENCES utilisateur(id),
  created_at             TIMESTAMP NOT NULL DEFAULT now(),
  updated_at             TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT contrat_dates_coherentes CHECK (date_fin IS NULL OR date_fin >= date_debut)
);

-- Un seul contrat actif par enseignant et par année : le contrôle de planification
-- (« l'enseignant est-il contractualisé ? ») doit avoir une réponse non ambiguë.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contrat_actif_par_annee
  ON contrat_enseignant (enseignant_id, annee_academique_id)
  WHERE statut = 'actif';

-- Classes d'intervention autorisées par le contrat.
CREATE TABLE IF NOT EXISTS contrat_classe (
  contrat_id INTEGER NOT NULL REFERENCES contrat_enseignant(id) ON DELETE CASCADE,
  classe_id  INTEGER NOT NULL REFERENCES classe(id),
  PRIMARY KEY (contrat_id, classe_id)
);

-- ---------------------------------------------------------------------------
--  8. Emploi du temps — trame théorique
--     « Conception d'un emploi du temps théorique/maquette sur une longue durée
--      (sans affectation immédiate de salles physiques). »
--     Une trame décrit un créneau récurrent ; les séances datées en sont dérivées.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trame_edt (
  id                  SERIAL PRIMARY KEY,
  annee_academique_id INTEGER NOT NULL REFERENCES anneeacademique(id),
  classe_id           INTEGER NOT NULL REFERENCES classe(id) ON DELETE CASCADE,
  matiere_id          INTEGER REFERENCES matiere(id),
  enseignant_id       INTEGER REFERENCES enseignant(id),
  intitule            VARCHAR(180),
  jour_semaine        SMALLINT NOT NULL CHECK (jour_semaine BETWEEN 1 AND 7),
  heure_debut         TIME NOT NULL,
  heure_fin           TIME NOT NULL,
  type_seance         VARCHAR(10) NOT NULL DEFAULT 'CM'
                      CHECK (type_seance IN ('CM', 'TD', 'TP', 'Examen', 'Autre')),
  date_debut          DATE NOT NULL,
  date_fin            DATE NOT NULL,
  frequence           VARCHAR(15) NOT NULL DEFAULT 'hebdomadaire'
                      CHECK (frequence IN ('hebdomadaire', 'quinzaine_paire', 'quinzaine_impaire')),
  statut              VARCHAR(10) NOT NULL DEFAULT 'active'
                      CHECK (statut IN ('active', 'annulee')),
  cree_par            INTEGER REFERENCES utilisateur(id),
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  updated_at          TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT trame_heures_coherentes CHECK (heure_fin > heure_debut),
  CONSTRAINT trame_dates_coherentes  CHECK (date_fin >= date_debut)
);

CREATE INDEX IF NOT EXISTS idx_trame_classe ON trame_edt(classe_id, annee_academique_id);

-- ---------------------------------------------------------------------------
--  9. Emploi du temps — séance datée
--     C'est ici que la salle physique est allouée, « au fur et à mesure ».
--     salle_id NULL = séance planifiée mais pas encore localisée.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seance_edt (
  id            SERIAL PRIMARY KEY,
  trame_id      INTEGER REFERENCES trame_edt(id) ON DELETE CASCADE,
  classe_id     INTEGER NOT NULL REFERENCES classe(id) ON DELETE CASCADE,
  matiere_id    INTEGER REFERENCES matiere(id),
  enseignant_id INTEGER REFERENCES enseignant(id),
  salle_id      INTEGER REFERENCES salle(id),
  intitule      VARCHAR(180),
  date_seance   DATE NOT NULL,
  heure_debut   TIME NOT NULL,
  heure_fin     TIME NOT NULL,
  type_seance   VARCHAR(10) NOT NULL DEFAULT 'CM'
                CHECK (type_seance IN ('CM', 'TD', 'TP', 'Examen', 'Autre')),
  statut        VARCHAR(12) NOT NULL DEFAULT 'planifiee'
                CHECK (statut IN ('planifiee', 'confirmee', 'annulee')),
  observations  TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT seance_heures_coherentes CHECK (heure_fin > heure_debut),

  -- Créneau exprimé en minutes depuis minuit : PostgreSQL n'a pas de type `timerange`
  -- natif, et un int4range généré permet à la fois l'opérateur de chevauchement `&&`
  -- et l'indexation gist exigée par la contrainte d'exclusion ci-dessous.
  creneau int4range GENERATED ALWAYS AS (
    int4range(
      (EXTRACT(HOUR FROM heure_debut) * 60 + EXTRACT(MINUTE FROM heure_debut))::int,
      (EXTRACT(HOUR FROM heure_fin)   * 60 + EXTRACT(MINUTE FROM heure_fin))::int
    )
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_seance_date       ON seance_edt(date_seance);
CREATE INDEX IF NOT EXISTS idx_seance_classe     ON seance_edt(classe_id, date_seance);
CREATE INDEX IF NOT EXISTS idx_seance_enseignant ON seance_edt(enseignant_id, date_seance);

-- Règle §4 « Gestion des conflits de salles » : une salle physique ne peut être
-- assignée à deux cours différents sur un créneau chevauchant. Garantie posée au
-- niveau de la base (et pas seulement dans le contrôleur) pour rester vraie même
-- si deux Chargés Pédagogiques réservent la même salle au même instant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'seance_salle_sans_chevauchement'
  ) THEN
    ALTER TABLE seance_edt ADD CONSTRAINT seance_salle_sans_chevauchement
      EXCLUDE USING gist (
        salle_id    WITH =,
        date_seance WITH =,
        creneau     WITH &&
      ) WHERE (salle_id IS NOT NULL AND statut <> 'annulee');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
--  10. Séquences des identifiants métier
--      Références et matricules sont générés côté base : dériver un numéro d'un
--      COUNT(*) ou d'un MAX() donnerait des doublons dès que deux RH valident deux
--      dossiers en même temps.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS enseignant_matricule_seq  START 1;
CREATE SEQUENCE IF NOT EXISTS candidature_reference_seq START 1;
CREATE SEQUENCE IF NOT EXISTS offre_reference_seq       START 1;

COMMIT;

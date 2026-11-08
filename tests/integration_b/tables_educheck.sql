-- Copie LOCALE de test des tables de l'application d'assiduité de Clovis (« EduCheck »),
-- reconstituée d'après ses migrations Django (Appels 0001 à 0004) : noms de tables par défaut
-- de Django (casse comprise), dans le schéma `appels` (premier de son search_path).
-- Colonnes limitées à celles que lit MyIIPEA. Ne jamais charger en production : en production,
-- ces tables sont créées par EduCheck lui-même.

CREATE SCHEMA IF NOT EXISTS appels;

CREATE TABLE IF NOT EXISTS appels."Appels_appel" (
  id            bigserial PRIMARY KEY,
  groupe_id     integer   NOT NULL,
  matiere_id    integer   NOT NULL,
  fait_par_id   bigint,
  date          date      NOT NULL,
  sequence      smallint  NOT NULL DEFAULT 1,
  heure_debut   time      NOT NULL,
  heure_fin     time,
  temps_du_cours interval,
  statut        varchar(20) NOT NULL DEFAULT 'brouillon',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  client_uuid   uuid,
  UNIQUE (groupe_id, matiere_id, date, sequence)
);

CREATE TABLE IF NOT EXISTS appels."Appels_presence" (
  id          bigserial PRIMARY KEY,
  appel_id    bigint     NOT NULL REFERENCES appels."Appels_appel" (id) ON DELETE CASCADE,
  etudiant_id integer    NOT NULL,
  statut      varchar(10) NOT NULL DEFAULT 'present',
  UNIQUE (appel_id, etudiant_id)
);

CREATE TABLE IF NOT EXISTS appels."Appels_justificatifabsence" (
  id          bigserial PRIMARY KEY,
  presence_id bigint      NOT NULL REFERENCES appels."Appels_presence" (id) ON DELETE CASCADE,
  date        date        NOT NULL,
  motif       varchar(200) NOT NULL,
  fichier     varchar(100),
  justifie    boolean     NOT NULL DEFAULT false,
  cree_le     timestamptz NOT NULL DEFAULT now()
);

-- Données fictives : groupe 1 (SIC L1-A), étudiants 1 et 2, matière 1.
INSERT INTO appels."Appels_appel" (id, groupe_id, matiere_id, date, sequence, heure_debut, heure_fin, statut) VALUES
  (1, 1, 1, '2026-10-12', 1, '08:00', '12:00', 'soumis'),
  (2, 1, 1, '2026-10-19', 1, '08:00', '12:00', 'soumis'),
  (3, 1, 1, '2026-10-26', 1, '08:00', '12:00', 'brouillon');
INSERT INTO appels."Appels_presence" (id, appel_id, etudiant_id, statut) VALUES
  (1, 1, 1, 'present'), (2, 1, 2, 'present'),
  (3, 2, 1, 'present'), (4, 2, 2, 'absent'),
  (5, 3, 1, 'absent'), (6, 3, 2, 'absent');
-- Absence du 19/10 : justificatif refusé puis justificatif validé (le dernier compte).
INSERT INTO appels."Appels_justificatifabsence" (presence_id, date, motif, justifie, cree_le) VALUES
  (4, '2026-10-19', 'Sans pièce', false, '2026-10-20 09:00+00'),
  (4, '2026-10-19', 'Certificat médical', true, '2026-10-21 09:00+00');

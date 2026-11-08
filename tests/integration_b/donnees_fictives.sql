-- Données FICTIVES pour tester l'intégration avec l'Application B sur une base LOCALE
-- (schéma de production + migration 001). Ne jamais charger en production.
-- Noms, matricules et établissements inventés (préfixe DEMO).

BEGIN;

INSERT INTO site (id, nom, adresse) VALUES
  (1, 'Cocody', 'Abidjan'), (2, 'Abobo', 'Abidjan'), (3, 'Yamoussoukro', 'Yamoussoukro');

INSERT INTO anneeacademique (id, annee, etat) VALUES (1, '2026-2027', 'en cour');
INSERT INTO anneeacademique_site (id, anneeacademique_id, site_id, etat, date_ouverture) VALUES
  (1, 1, 1, 'en cour', '2026-09-01 07:00'), (2, 1, 2, 'en cour', '2026-09-01 07:00'),
  (3, 1, 3, 'en cour', '2026-09-01 07:00');

INSERT INTO semestre (id, nom) VALUES (1, 'Semestre 1'), (2, 'Semestre 2');

INSERT INTO ecole (id, nom, code) VALUES (1, 'École de communication (DEMO)', 'ECD');
INSERT INTO departement (id, nom, sigle, ecole_id) VALUES (1, 'Département communication (DEMO)', 'DCOM', 1);
INSERT INTO typefiliere (id, libelle) VALUES (1, 'Grande école — formation initiale');
INSERT INTO filiere (id, nom, sigle, type_filiere_id, departement_id) VALUES
  (1, 'Sciences de l''information et de la communication (DEMO)', 'SIC', 1, 1);
INSERT INTO curcus (id, type_parcours) VALUES (1, 'Classique');

INSERT INTO niveau (id, libelle, filiere_id, anneeacademique_id, site_id, ordre) VALUES
  (1, 'LICENCE 1', 1, 1, 1, 1), (2, 'LICENCE 2 PRO', 1, 1, 1, 2);
INSERT INTO classe (id, nom, annee_academique_id, niveau_id, filiere_id, curcus_id) VALUES
  (1, 'SIC L1 2026-2027', 1, 1, 1, 1), (2, 'SIC L2 PRO 2026-2027', 1, 2, 1, 1);
INSERT INTO groupe (id, nom, capacite_max, classe_id, est_primaire) VALUES
  (1, 'SIC L1-A', 50, 1, true), (2, 'SIC L1-B', 50, 1, false), (3, 'SIC L2 PRO-A', 40, 2, true);

INSERT INTO etudiant (id, matricule, matricule_iipea, nom, prenoms, standing, groupe_id, niveau_id,
                      site_id, date_inscription, annee_academique_id) VALUES
  (1, 'D1', 'DEMO-2026-0001', 'KONE', 'Awa', 'Inscrit', 1, 1, 1, '2026-09-01', 1),
  (2, 'D2', 'DEMO-2026-0002', 'TRAORE', 'Koffi', 'Inscrit', 1, 1, 1, '2026-09-01', 1),
  (3, 'D3', 'DEMO-2026-0003', 'BAMBA', 'Aminata', 'Inscrit', 2, 1, 1, '2026-09-02', 1),
  (4, 'D4', 'DEMO-2026-0004', 'COULIBALY', 'Yao', 'en attente', 2, 1, 1, '2026-09-03', 1),
  (5, 'D5', 'DEMO-2026-0005', 'DIALLO', 'Fatou', 'Inscrit', 3, 2, 1, '2026-09-01', 1),
  (6, 'D6', NULL, 'SANS', 'Matricule', 'en attente', NULL, 1, 1, '2026-09-05', 1);

INSERT INTO categorie (id, nom) VALUES (1, 'Fondamentale');
INSERT INTO maquette (id, filiere_id, niveau_id, anneeacademique_id, parcour) VALUES (1, 1, 1, 1, NULL);
INSERT INTO ue (id, libelle, maquette_id, semestre_id, categorie_id, code_ue) VALUES
  (1, 'Fondamentaux de la communication', 1, 1, 1, 'UE-SIC-101');
INSERT INTO matiere (id, nom, coefficient, ue_id, volume_horaire_cm, taux_horaire_cm,
                     volume_horaire_td, taux_horaire_td, code_ecue, credits) VALUES
  (1, 'Théories de la communication', 2, 1, 20, 9999, 10, 8888, 'ECUE-SIC-1011', 3),
  (2, 'Expression écrite', 1, 1, 10, 9999, 10, 8888, 'ECUE-SIC-1012', 2);

COMMIT;

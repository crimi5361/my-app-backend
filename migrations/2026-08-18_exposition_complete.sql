-- ============================================================================
--  Assistant Fondateur — exposition complète du schéma (2026-08-18)
--
--  Le fondateur veut que l'assistante puisse répondre sur TOUTES les tables,
--  pas seulement sur les 29 atteintes par les vues métier. Cette migration crée
--  un reflet en lecture de chaque table, sous le nom assistant.t_<table>.
--
--  CE QUI EST CONSERVÉ, et qui interdisait un simple GRANT sur public :
--
--    1. LES MOTS DE PASSE ne sont dans aucune vue. etudiant.password,
--       utilisateur.mot_de_passe et assistant_google_compte.jeton_rafraichissement
--       sont retirés colonne par colonne, pas masqués par une convention.
--
--    2. LE CLOISONNEMENT PAR SITE est appliqué partout où un chemin existe :
--       directement quand la table porte site_id, en un saut par l'étudiant
--       quand elle porte etudiant_id. Les tables sans chemin sont listées en fin
--       de fichier : ce sont des référentiels, ou des tables dont le
--       rattachement au site n'est pas exprimable en SQL simple.
--
--    3. LES VUES MÉTIER v_* RESTENT LE CHEMIN RECOMMANDÉ. Elles portent les
--       jointures, les libellés lisibles et les règles de gestion. Les vues t_*
--       sont un filet : elles répondent aux questions que les v_* ne couvrent
--       pas, au prix d'un SQL plus brut.
--
--  Migration additive : aucune table modifiée, aucune donnée touchée.
-- ============================================================================

BEGIN;

-- accessoire
CREATE OR REPLACE VIEW assistant.t_accessoire AS
SELECT
  "id",
  "code",
  "nom",
  "actif",
  "seuil_alerte_defaut",
  "created_at",
  "description",
  "updated_at",
  "cout_unitaire_reference"
FROM accessoire;
COMMENT ON VIEW assistant.t_accessoire IS
  'Article du stock scolaire, 4 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- affectation_charge_pedagogique
CREATE OR REPLACE VIEW assistant.t_affectation_charge_pedagogique AS
SELECT
  "id",
  "utilisateur_id",
  "filiere_id",
  "niveau_id",
  "affecte_par",
  "created_at"
FROM affectation_charge_pedagogique;
COMMENT ON VIEW assistant.t_affectation_charge_pedagogique IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- annee_bac
CREATE OR REPLACE VIEW assistant.t_annee_bac AS
SELECT
  "id",
  "annee"
FROM annee_bac;
COMMENT ON VIEW assistant.t_annee_bac IS
  'Référentiel des années d''obtention du bac, 27 lignes mesurées le 2026-08-15. etudiant.annee_bac est un varchar libre, PAS une FOREIGN KEY vers cette table. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- anneeacademique
CREATE OR REPLACE VIEW assistant.t_anneeacademique AS
SELECT
  "id",
  "annee"
FROM anneeacademique;
COMMENT ON VIEW assistant.t_anneeacademique IS
  'Référentiel des années académiques (ex. ''2025-2026''), 2 lignes mesurées le 2026-08-15. Référencée par de très nombreuses tables (paiement, etudiant, niveau, classe, inscription_annuelle...). Contrainte UNIQUE(annee). Absente du rang A/B/C/D d''origine, ajoutée en rang C. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- anneeacademique_site
CREATE OR REPLACE VIEW assistant.t_anneeacademique_site AS
SELECT
  "id",
  "anneeacademique_id",
  "site_id",
  "etat",
  "date_ouverture",
  "date_fermeture"
FROM anneeacademique_site
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_anneeacademique_site IS
  'Ouverture d''une année académique pour un site donné, 2 lignes mesurées le 2026-08-15. RÈGLE MÉTIER GARANTIE PAR LE SCHÉMA (index unique partiel) : au plus une ligne à l''état ''en cour'' par site. — Cloisonnée par site_id.';

-- assistant_consommation
CREATE OR REPLACE VIEW assistant.t_assistant_consommation AS
SELECT
  "id",
  "site_id",
  "utilisateur_id",
  "canal",
  "modele",
  "jetons_entree",
  "jetons_sortie",
  "jetons_audio_entree",
  "jetons_audio_sortie",
  "cout_usd",
  "cree_le"
FROM assistant_consommation
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_assistant_consommation IS
  'Consommation de l''Assistant Fondateur, un enregistrement par appel au modèle. Sert au plafond mensuel applicatif et à l''affichage du budget consommé. — Cloisonnée par site_id.';

-- assistant_google_compte  [retiré : jeton_rafraichissement]
CREATE OR REPLACE VIEW assistant.t_assistant_google_compte AS
SELECT
  "utilisateur_id",
  "site_id",
  "email_google",
  "portees",
  "cree_le",
  "maj_le"
FROM assistant_google_compte
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_assistant_google_compte IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Migration très récente (2026-08-12e_assistant_google.sql) : aucun compte Google configuré localement. — Cloisonnée par site_id. Colonne(s) retirée(s) : jeton_rafraichissement.';

-- assistant_reglages
CREATE OR REPLACE VIEW assistant.t_assistant_reglages AS
SELECT
  "site_id",
  "nom_assistant",
  "lancement_vocal",
  "recherche_web",
  "maj_le",
  "maj_par",
  "voix",
  "civilite"
FROM assistant_reglages
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_assistant_reglages IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Migration très récente (2026-08-13d_assistant_reglages.sql) : aucun réglage de site initialisé localement. — Cloisonnée par site_id.';

-- besoin_enseignant
CREATE OR REPLACE VIEW assistant.t_besoin_enseignant AS
SELECT
  "id",
  "annee_academique_id",
  "filiere_id",
  "niveau_id",
  "matiere_id",
  "intitule",
  "specialite_attendue",
  "volume_horaire_prevu",
  "nombre_postes",
  "priorite",
  "statut",
  "commentaire",
  "cree_par",
  "created_at",
  "updated_at"
FROM besoin_enseignant;
COMMENT ON VIEW assistant.t_besoin_enseignant IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- caisse
CREATE OR REPLACE VIEW assistant.t_caisse AS
SELECT
  "id",
  "code",
  "libelle",
  "statut",
  "mode_reouverture",
  "site_id"
FROM caisse
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_caisse IS
  'Caisse physique/logique d''un site, point d''encaissement des paiements, 3 lignes mesurées le 2026-08-15. — Cloisonnée par site_id.';

-- candidature_diplome
CREATE OR REPLACE VIEW assistant.t_candidature_diplome AS
SELECT
  "id",
  "candidature_id",
  "intitule",
  "etablissement",
  "annee_obtention",
  "fichier_path",
  "created_at"
FROM candidature_diplome;
COMMENT ON VIEW assistant.t_candidature_diplome IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- candidature_enseignant
CREATE OR REPLACE VIEW assistant.t_candidature_enseignant AS
SELECT
  "id",
  "reference",
  "nom",
  "prenoms",
  "email",
  "telephone",
  "date_naissance",
  "genre",
  "nationalite",
  "grade",
  "specialite",
  "annees_experience",
  "cv_path",
  "cv_original_name",
  "lettre_motivation",
  "offre_id",
  "source",
  "statut",
  "commentaire_cp",
  "cp_evaluateur_id",
  "date_prevalidation",
  "commentaire_rh",
  "motif_refus",
  "rh_valideur_id",
  "date_decision",
  "created_at",
  "updated_at"
FROM candidature_enseignant;
COMMENT ON VIEW assistant.t_candidature_enseignant IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), introduit par migrations/2026-08-11_module_enseignants.sql, pas encore utilisé localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- candidature_filiere
CREATE OR REPLACE VIEW assistant.t_candidature_filiere AS
SELECT
  "candidature_id",
  "filiere_id"
FROM candidature_filiere;
COMMENT ON VIEW assistant.t_candidature_filiere IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- categorie
CREATE OR REPLACE VIEW assistant.t_categorie AS
SELECT
  "id",
  "nom"
FROM categorie;
COMMENT ON VIEW assistant.t_categorie IS
  'Référentiel des catégories d''UE, 1 ligne mesurée le 2026-08-15 (non représentatif). — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- classe
CREATE OR REPLACE VIEW assistant.t_classe AS
SELECT
  "id",
  "nom",
  "description",
  "annee_academique_id",
  "niveau_id",
  "filiere_id",
  "curcus_id"
FROM classe;
COMMENT ON VIEW assistant.t_classe IS
  'Classe pédagogique (année académique x niveau x filière), 155 lignes mesurées le 2026-08-15. Recréée chaque année académique (filiere reste permanente, voir la documentation interne). — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- commande_fournisseur
CREATE OR REPLACE VIEW assistant.t_commande_fournisseur AS
SELECT
  "id",
  "fournisseur_id",
  "site_id",
  "statut",
  "date_commande",
  "created_at",
  "updated_at"
FROM commande_fournisseur
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_commande_fournisseur IS
  'Commande passée à un fournisseur, 1 ligne mesurée le 2026-08-15 (module peu utilisé). — Cloisonnée par site_id.';

-- contrat_classe
CREATE OR REPLACE VIEW assistant.t_contrat_classe AS
SELECT
  "contrat_id",
  "classe_id"
FROM contrat_classe;
COMMENT ON VIEW assistant.t_contrat_classe IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- contrat_enseignant
CREATE OR REPLACE VIEW assistant.t_contrat_enseignant AS
SELECT
  "id",
  "enseignant_id",
  "annee_academique_id",
  "type_contrat",
  "taux_horaire",
  "volume_horaire_global",
  "date_debut",
  "date_fin",
  "statut",
  "observations",
  "etabli_par",
  "created_at",
  "updated_at"
FROM contrat_enseignant;
COMMENT ON VIEW assistant.t_contrat_enseignant IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- curcus
CREATE OR REPLACE VIEW assistant.t_curcus AS
SELECT
  "id",
  "type_parcours"
FROM curcus;
COMMENT ON VIEW assistant.t_curcus IS
  'Référentiel des types de parcours, 3 lignes mesurées le 2026-08-15. curcus_id est décliné en FOREIGN KEY sur plusieurs tables mais reste NON ALIMENTÉ sur inscription_annuelle localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- decoupage_groupe
CREATE OR REPLACE VIEW assistant.t_decoupage_groupe AS
SELECT
  "id",
  "classe_id",
  "effectue_par",
  "date_decoupage",
  "strategie",
  "nombre_groupes",
  "nombre_etudiants_repartis",
  "detail_groupes"
FROM decoupage_groupe;
COMMENT ON VIEW assistant.t_decoupage_groupe IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Fonctionnalité de répartition automatique de groupes, jamais déclenchée localement (A CONFIRMER). — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- departement
CREATE OR REPLACE VIEW assistant.t_departement AS
SELECT
  "id",
  "nom",
  "sigle",
  "ecole_id",
  "created_at"
FROM departement;
COMMENT ON VIEW assistant.t_departement IS
  'Département pédagogique au sein d''une école, 5 lignes mesurées le 2026-08-15. Contrainte UNIQUE(ecole_id, nom). — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- distribution
CREATE OR REPLACE VIEW assistant.t_distribution AS
SELECT
  "id",
  "etudiant_id",
  "annee_academique_id",
  "agent_id",
  "emplacement_stock_id",
  "date_remise",
  "numero_recu",
  "ecole_nom",
  "filiere_nom",
  "niveau_nom",
  "classe_nom",
  "site_nom"
FROM distribution
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_distribution IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module stock, aucune distribution enregistrée localement (module globalement peu alimenté : accessoire 4 lignes, fournisseur 1 ligne). — Cloisonnée par l''étudiant rattaché.';

-- document
CREATE OR REPLACE VIEW assistant.t_document AS
SELECT
  "id",
  "extrait_naissance",
  "justificatif_identite",
  "dernier_diplome",
  "fiche_orientation"
FROM document
WHERE id IN (SELECT document_id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_document IS
  'Checklist des pièces administratives d''un dossier étudiant à l''admission (4 colonnes texte), 9395 lignes mesurées le 2026-08-15, référencée par etudiant.document_id. — Cloisonnée par rattachement indirect.';

-- document_etudiant
CREATE OR REPLACE VIEW assistant.t_document_etudiant AS
SELECT
  "id",
  "etudiant_id",
  "type_document_id",
  "fourni",
  "fichier_path",
  "date_upload",
  "storage_provider",
  "drive_file_id",
  "drive_folder_id",
  "declare_par_etudiant"
FROM document_etudiant
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_document_etudiant IS
  'Suivi de fourniture d''un document administratif (par type_document) par un étudiant, 157 lignes mesurées le 2026-08-15. Contrainte UNIQUE(etudiant_id, type_document_id). — Cloisonnée par l''étudiant rattaché.';

-- ecole
CREATE OR REPLACE VIEW assistant.t_ecole AS
SELECT
  "id",
  "nom",
  "code",
  "description",
  "statut",
  "created_at",
  "updated_at"
FROM ecole;
COMMENT ON VIEW assistant.t_ecole IS
  'École au sein de l''établissement, 5 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- emplacement_stock
CREATE OR REPLACE VIEW assistant.t_emplacement_stock AS
SELECT
  "id",
  "site_id",
  "nom"
FROM emplacement_stock
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_emplacement_stock IS
  'Emplacement physique de stockage rattaché à un site, 3 lignes mesurées le 2026-08-15. — Cloisonnée par site_id.';

-- emploi_du_temps
CREATE OR REPLACE VIEW assistant.t_emploi_du_temps AS
SELECT
  "id",
  "groupe_id",
  "file_path",
  "original_name",
  "uploaded_at"
FROM emploi_du_temps;
COMMENT ON VIEW assistant.t_emploi_du_temps IS
  'Fichier d''emploi du temps uploadé pour un groupe (dépôt simple), 160 lignes mesurées le 2026-08-15. NE PAS CONFONDRE avec seance_edt/trame_edt (module Enseignants, planification structurée, vide localement). — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- enseignant
CREATE OR REPLACE VIEW assistant.t_enseignant AS
SELECT
  "id",
  "matricule",
  "candidature_id",
  "professeur_id",
  "utilisateur_id",
  "nom",
  "prenoms",
  "email",
  "telephone",
  "grade",
  "specialite",
  "cv_path",
  "site_id",
  "ecole_id",
  "date_recrutement",
  "statut",
  "created_at",
  "updated_at"
FROM enseignant
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_enseignant IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement. NE PAS CONFONDRE avec professeur (module historique notes/enseignements, 115 lignes). — Cloisonnée par site_id.';

-- enseignement
CREATE OR REPLACE VIEW assistant.t_enseignement AS
SELECT
  "id",
  "professeur_id",
  "matiere_id",
  "groupe_id",
  "annee_academique",
  "created_at",
  "updated_at"
FROM enseignement;
COMMENT ON VIEW assistant.t_enseignement IS
  'Rattachement (professeur x matière x groupe) pour une année académique, 1981 lignes mesurées le 2026-08-15. Contrainte UNIQUE(professeur_id, matiere_id, groupe_id, annee_academique). — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- etablissement_origine
CREATE OR REPLACE VIEW assistant.t_etablissement_origine AS
SELECT
  "id",
  "nom_etablissement",
  "situation_geographique",
  "statut",
  "dren",
  "created_at",
  "updated_at"
FROM etablissement_origine;
COMMENT ON VIEW assistant.t_etablissement_origine IS
  'Référentiel des établissements d''origine des étudiants, 1226 lignes mesurées le 2026-08-15. ATTENTION : etudiant.etablissement_origine est un champ TEXTE LIBRE, PAS une FOREIGN KEY vers cette table malgré le nom identique. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- etudiant  [retiré : password]
CREATE OR REPLACE VIEW assistant.t_etudiant AS
SELECT
  "id",
  "matricule",
  "nom",
  "prenoms",
  "date_naissance",
  "lieu_naissance",
  "telephone",
  "email",
  "lieu_residence",
  "contact_parent",
  "code_unique",
  "annee_bac",
  "serie_bac",
  "etablissement_origine",
  "inscrit_par",
  "photo_url",
  "date_inscription",
  "site_id",
  "annee_academique_id",
  "groupe_id",
  "niveau_id",
  "document_id",
  "scolarite_id",
  "statut_scolaire",
  "nationalite",
  "standing",
  "numero_table",
  "sexe",
  "curcus_id",
  "id_filiere",
  "contact_etudiant",
  "contact_parent_2",
  "matricule_iipea",
  "pays_naissance",
  "nom_parent_1",
  "nom_parent_2",
  "ip_ministere",
  "numero_acte_naissance",
  "numero_piece_identite",
  "mention_bac",
  "session_bac",
  "adresse_parent_1",
  "adresse_parent_2",
  "engagement_accepte",
  "code_paiement",
  "nombre_versements_prevu",
  "source_inscription",
  "valide_scolarite",
  "email_personnel",
  "verifie_par",
  "date_verification",
  "observation_verification"
FROM etudiant
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_etudiant IS
  'Position académique et administrative COURANTE d''un étudiant (1 ligne par étudiant, mesuré 7201 lignes le 2026-08-15). PAS un historique : voir inscription_annuelle et historique_inscription pour l''historique par année, et public.vue_position_academique comme SEULE source de lecture recommandée pour les données historiques. Beaucoup de colonnes de type référence (site_id, annee_academique_id, groupe_id, niveau_id, document_id, scolarite_id, curcus_id, id_filiere) n''ont AUCUNE contrainte FOREIGN KEY déclarée. — Cloisonnée par site_id. Colonne(s) retirée(s) : password.';

-- filiere
CREATE OR REPLACE VIEW assistant.t_filiere AS
SELECT
  "id",
  "nom",
  "sigle",
  "type_filiere_id",
  "departement_id",
  "filiere_mere_id"
FROM filiere;
COMMENT ON VIEW assistant.t_filiere IS
  'Filière de formation, PERMANENTE d''une année sur l''autre (contrairement à classe/niveau/tarif/maquette), 29 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- fournisseur
CREATE OR REPLACE VIEW assistant.t_fournisseur AS
SELECT
  "id",
  "nom",
  "statut",
  "created_at",
  "contact_nom",
  "telephone",
  "email",
  "adresse",
  "ville",
  "observations",
  "updated_at"
FROM fournisseur;
COMMENT ON VIEW assistant.t_fournisseur IS
  'Fournisseur pour les commandes de stock, 1 ligne mesurée le 2026-08-15 (module peu utilisé). — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- groupe
CREATE OR REPLACE VIEW assistant.t_groupe AS
SELECT
  "id",
  "nom",
  "capacite_max",
  "classe_id",
  "est_primaire"
FROM groupe
WHERE id IN (SELECT groupe_id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_groupe IS
  'Groupe d''étudiants au sein d''une classe, 216 lignes mesurées le 2026-08-15. Référencé par etudiant.groupe_id SANS contrainte FOREIGN KEY (7 orphelins observés, voir etudiant). — Cloisonnée par rattachement indirect.';

-- historique_inscription
CREATE OR REPLACE VIEW assistant.t_historique_inscription AS
SELECT
  "id",
  "etudiant_id",
  "type_evenement",
  "annee_academique_id",
  "niveau_id",
  "id_filiere",
  "groupe_id",
  "statut_scolaire",
  "montant_scolarite",
  "scolarite_verse",
  "scolarite_restante",
  "statut_paiement",
  "decision_academique",
  "moyenne_annuelle",
  "reinscription_id",
  "created_at",
  "valide_par",
  "curcus_id"
FROM historique_inscription
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_historique_inscription IS
  'Position académique FIGÉE d''un étudiant pour une année académique clôturée (9 lignes mesurées le 2026-08-15), alimentée à chaque réinscription/clôture. Combinée à etudiant par public.vue_position_academique (UNION ALL, filtrée sur type_evenement=''cloture'') : SEULE source de lecture recommandée pour les données historiques. ATTENTION — le commentaire existant sur assistant.v_activite_agents affirme que cette table est vide : c''est désormais FAUX (9 lignes), commentaire obsolète signalé pour action future. — Cloisonnée par l''étudiant rattaché.';

-- historique_operations_admin
CREATE OR REPLACE VIEW assistant.t_historique_operations_admin AS
SELECT
  "id",
  "etudiant_id",
  "type_operation",
  "anciennes_valeurs",
  "nouvelles_valeurs",
  "motif",
  "utilisateur_id",
  "created_at"
FROM historique_operations_admin
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_historique_operations_admin IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Aucun changement de filière/parcours/cycle exceptionnel (hors réinscription) enregistré localement, voir la documentation interne. — Cloisonnée par l''étudiant rattaché.';

-- inscription_annuelle
CREATE OR REPLACE VIEW assistant.t_inscription_annuelle AS
SELECT
  "id",
  "etudiant_id",
  "annee_academique_id",
  "niveau_id",
  "id_filiere",
  "groupe_id",
  "classe_id",
  "site_id",
  "statut_scolaire",
  "standing",
  "moyenne_s1",
  "credits_s1_valides",
  "credits_s1_total",
  "decision_s1",
  "moyenne_s2",
  "credits_s2_valides",
  "credits_s2_total",
  "decision_s2",
  "moyenne_annuelle",
  "credits_annuels_valides",
  "credits_annuels_total",
  "decision_annuelle",
  "matieres_a_reprendre",
  "montant_scolarite",
  "code_paiement",
  "type_evenement",
  "reinscription_source_id",
  "valide_par",
  "created_at",
  "updated_at",
  "curcus_id"
FROM inscription_annuelle
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_inscription_annuelle IS
  'Position académique d''un étudiant POUR UNE ANNÉE ACADÉMIQUE DONNÉE (snapshot annuel), 7200 lignes mesurées le 2026-08-15. RÈGLE ANTI DOUBLE-COMPTAGE : contrainte UNIQUE(etudiant_id, annee_academique_id) — une seule ligne par étudiant et par année. Les données locales proviennent d''une migration technique (type_evenement = ''migration_position_courante''/''migration_historique''), pas encore du flux normal de réinscription. — Cloisonnée par site_id.';

-- kit
CREATE OR REPLACE VIEW assistant.t_kit AS
SELECT
  "id",
  "etudiant_id",
  "montant",
  "deposer",
  "date_enregistrement",
  "annee_academique_id"
FROM kit
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_kit IS
  'Frais/dépôt de kit scolaire d''un étudiant pour une année académique, 7314 lignes mesurées le 2026-08-15. Certaines années peuvent être suspendues pour ce module (variable KIT_ANNEES_SUSPENDUES). — Cloisonnée par l''étudiant rattaché.';

-- ligne_commande_fournisseur
CREATE OR REPLACE VIEW assistant.t_ligne_commande_fournisseur AS
SELECT
  "id",
  "commande_id",
  "accessoire_id",
  "quantite_commandee",
  "quantite_recue"
FROM ligne_commande_fournisseur;
COMMENT ON VIEW assistant.t_ligne_commande_fournisseur IS
  'Ligne de détail (accessoire x quantité) d''une commande fournisseur, 4 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- ligne_distribution
CREATE OR REPLACE VIEW assistant.t_ligne_distribution AS
SELECT
  "id",
  "distribution_id",
  "accessoire_id",
  "quantite"
FROM ligne_distribution;
COMMENT ON VIEW assistant.t_ligne_distribution IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module stock, voir distribution. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- maquette
CREATE OR REPLACE VIEW assistant.t_maquette AS
SELECT
  "id",
  "filiere_id",
  "niveau_id",
  "anneeacademique_id",
  "date_creation",
  "parcour"
FROM maquette;
COMMENT ON VIEW assistant.t_maquette IS
  'Maquette pédagogique (filière x niveau x année académique), regroupant les UE, 118 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- matiere
CREATE OR REPLACE VIEW assistant.t_matiere AS
SELECT
  "id",
  "nom",
  "coefficient",
  "ue_id",
  "volume_horaire_cm",
  "taux_horaire_cm",
  "volume_horaire_td",
  "taux_horaire_td",
  "type_evaluation",
  "updated_at",
  "code_ecue",
  "credits"
FROM matiere;
COMMENT ON VIEW assistant.t_matiere IS
  'Matière (ECUE) rattachée à une UE, 1701 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- memoire
CREATE OR REPLACE VIEW assistant.t_memoire AS
SELECT
  "id",
  "etudiant_id",
  "annee_academique_id",
  "theme",
  "fichier_pdf",
  "statut",
  "motif_refus",
  "date_depot",
  "date_traitement",
  "traite_par",
  "rapport_analyse"
FROM memoire
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_memoire IS
  'Dépôt de mémoire de fin d''études d''un étudiant pour une année académique, 461 lignes mesurées le 2026-08-15, avec circuit de validation (statut). — Cloisonnée par l''étudiant rattaché.';

-- mouvement_stock
CREATE OR REPLACE VIEW assistant.t_mouvement_stock AS
SELECT
  "id",
  "accessoire_id",
  "emplacement_stock_id",
  "type",
  "quantite",
  "reference_type",
  "reference_id",
  "effectue_par",
  "date_mouvement",
  "motif"
FROM mouvement_stock
WHERE emplacement_stock_id IN (SELECT id FROM emplacement_stock WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_mouvement_stock IS
  'Mouvement de stock d''un accessoire (réception/distribution/ajustement/transfert), 6 lignes mesurées le 2026-08-15 (module peu utilisé localement). — Cloisonnée par rattachement indirect.';

-- niveau
CREATE OR REPLACE VIEW assistant.t_niveau AS
SELECT
  "id",
  "libelle",
  "prix_formation",
  "type_filiere",
  "filiere_id",
  "site_id",
  "anneeacademique_id",
  "niveau_suivant_id",
  "ordre"
FROM niveau
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_niveau IS
  'Niveau d''études (filière x année académique x site), 148 lignes mesurées le 2026-08-15. Recréé chaque année académique comme classe/tarif/maquette. — Cloisonnée par site_id.';

-- note
CREATE OR REPLACE VIEW assistant.t_note AS
SELECT
  "id",
  "note1",
  "note2",
  "partiel",
  "etudiant_id",
  "session_id",
  "semestre_id",
  "moyenne",
  "coefficient",
  "statut",
  "fichier_source",
  "created_at",
  "updated_at",
  "enseignement_id"
FROM note
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_note IS
  'Une évaluation d''un étudiant dans un enseignement donné (105353 lignes mesurées le 2026-08-15). AUCUNE clé primaire ni contrainte FOREIGN KEY déclarée sur cette table (seulement 2 contraintes CHECK sur les plages de valeurs). Les colonnes note1/note2/partiel ne sont pas toutes pertinentes pour chaque matière : voir matiere.type_evaluation avant tout calcul de moyenne. — Cloisonnée par l''étudiant rattaché.';

-- offre_emploi_enseignant
CREATE OR REPLACE VIEW assistant.t_offre_emploi_enseignant AS
SELECT
  "id",
  "reference",
  "titre",
  "description",
  "specialite",
  "besoin_id",
  "filiere_id",
  "niveau_id",
  "site_id",
  "type_contrat",
  "volume_horaire_indicatif",
  "profil_recherche",
  "date_publication",
  "date_cloture",
  "statut",
  "publiee_par",
  "created_at",
  "updated_at"
FROM offre_emploi_enseignant
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_offre_emploi_enseignant IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement. — Cloisonnée par site_id.';

-- paiement
CREATE OR REPLACE VIEW assistant.t_paiement AS
SELECT
  "id",
  "montant",
  "date_paiement",
  "methode",
  "effectue_par",
  "etudiant_id",
  "recu_id",
  "caisse_id",
  "type_frais",
  "reference_transaction",
  "statut",
  "annee_academique_id",
  "session_caisse_id"
FROM paiement
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_paiement IS
  'Un encaissement individuel via le module Caisse (11734 lignes mesurées le 2026-08-15). ATTENTION — NE COUVRE PAS tout l''historique des règlements : les montants repris à la mise en service n''y figurent pas. SUM(paiement.montant) N''EST PAS le chiffre d''affaires / total des recettes de l''établissement. La RÉFÉRENCE pour ''chiffre d''affaires'', ''recettes'', ''total encaissé'' est scolarite.scolarite_verse (voir public.vue_position_academique). À utiliser pour l''activité de caisse (encaissements du jour/du mois, par caissier, par mode de paiement). etudiant_id et recu_id référencent etudiant/recu SANS contrainte FOREIGN KEY (fiable en pratique : 0 orphelin observé). — Cloisonnée par l''étudiant rattaché.';

-- pays
CREATE OR REPLACE VIEW assistant.t_pays AS
SELECT
  "id",
  "code_iso",
  "nom",
  "nationalite"
FROM pays;
COMMENT ON VIEW assistant.t_pays IS
  'Référentiel des pays (nationalité, code ISO), 195 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- permission
CREATE OR REPLACE VIEW assistant.t_permission AS
SELECT
  "id",
  "nom",
  "description"
FROM permission;
COMMENT ON VIEW assistant.t_permission IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Les rôles semblent gérés directement via utilisateur.role_id/role plutôt que via ce système de permissions granulaires (A CONFIRMER). — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- prise_en_charge
CREATE OR REPLACE VIEW assistant.t_prise_en_charge AS
SELECT
  "id",
  "reference",
  "type_pec",
  "pourcentage_reduction",
  "montant_reduction",
  "statut",
  "date_demande",
  "date_validation",
  "valide_par",
  "etudiant_id",
  "motif_refus",
  "annee_academique_id"
FROM prise_en_charge
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_prise_en_charge IS
  'Réduction ou prise en charge institutionnelle des frais de scolarité (bourse, convention entreprise), 224 lignes mesurées le 2026-08-15. Mouvement DISTINCT des paiements réels (ne pas combiner avec paiement.montant pour un coût total). — Cloisonnée par l''étudiant rattaché.';

-- professeur
CREATE OR REPLACE VIEW assistant.t_professeur AS
SELECT
  "id",
  "nom",
  "prenom",
  "date_creation",
  "statut"
FROM professeur;
COMMENT ON VIEW assistant.t_professeur IS
  'Enseignant utilisé par le module notes/enseignements historique (enseignement.professeur_id), 115 lignes mesurées le 2026-08-15. NE PAS CONFONDRE avec la table enseignant (module RH plus récent, vide localement). — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- reception_fournisseur
CREATE OR REPLACE VIEW assistant.t_reception_fournisseur AS
SELECT
  "id",
  "commande_id",
  "date_reception",
  "recu_par",
  "reference_bl",
  "observation"
FROM reception_fournisseur;
COMMENT ON VIEW assistant.t_reception_fournisseur IS
  'Réception physique d''une commande fournisseur, 2 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- recu
CREATE OR REPLACE VIEW assistant.t_recu AS
SELECT
  "id",
  "numero_recu",
  "date_emission",
  "montant",
  "emetteur"
FROM recu
WHERE id IN (SELECT p.recu_id FROM paiement p JOIN etudiant e ON e.id = p.etudiant_id WHERE e.site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_recu IS
  'Justificatif d''encaissement associé à un paiement (11844 lignes mesurées le 2026-08-15). AUCUNE CONTRAINTE DU TOUT sur cette table : ni PRIMARY KEY, ni UNIQUE, ni FOREIGN KEY, ni même un index. Environ 110 reçus ne sont référencés par aucun paiement. — Cloisonnée par rattachement indirect.';

-- reinscription
CREATE OR REPLACE VIEW assistant.t_reinscription AS
SELECT
  "id",
  "etudiant_id",
  "anneeacademique_id",
  "niveau_precedent_id",
  "niveau_propose_id",
  "niveau_retenu_id",
  "moyenne_annuelle",
  "credits_valides",
  "credits_total",
  "decision_academique",
  "matieres_a_reprendre",
  "scolarite_soldee",
  "montant_restant_precedent",
  "montant_annuel_nouveau",
  "statut",
  "traite_par",
  "created_at",
  "updated_at",
  "code_paiement",
  "nombre_versements_prevu",
  "modalite_paiement",
  "motif_non_eligibilite",
  "id_filiere_retenu",
  "statut_scolaire_retenu",
  "curcus_id",
  "source_inscription",
  "valide_scolarite",
  "verifie_par",
  "date_verification",
  "observation_verification"
FROM reinscription
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_reinscription IS
  'Cloisonnée par l''étudiant rattaché.';

-- resultat
CREATE OR REPLACE VIEW assistant.t_resultat AS
SELECT
  "id",
  "moyenne",
  "decision",
  "etudiant_id",
  "session_id"
FROM resultat
WHERE etudiant_id IN (SELECT id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_resultat IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Ses colonnes (moyenne, decision, etudiant_id, session_id) font doublon fonctionnel avec inscription_annuelle.moyenne_annuelle/decision_annuelle — hypothèse d''une table supplantée, NON CONFIRMÉE. Ne pas s''appuyer dessus. — Cloisonnée par l''étudiant rattaché.';

-- role
CREATE OR REPLACE VIEW assistant.t_role AS
SELECT
  "id",
  "nom",
  "description"
FROM role;
COMMENT ON VIEW assistant.t_role IS
  'Référentiel des rôles applicatifs, 10 lignes mesurées le 2026-08-15. Référencé par utilisateur.role_id SANS contrainte FOREIGN KEY. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- rolepermission
CREATE OR REPLACE VIEW assistant.t_rolepermission AS
SELECT
  "role_id",
  "permission_id"
FROM rolepermission;
COMMENT ON VIEW assistant.t_rolepermission IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Voir permission. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- salle
CREATE OR REPLACE VIEW assistant.t_salle AS
SELECT
  "id",
  "code",
  "nom",
  "site_id",
  "batiment",
  "etage",
  "capacite",
  "type_salle",
  "equipements",
  "statut",
  "observations",
  "created_at",
  "updated_at"
FROM salle
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_salle IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (planification), pas encore utilisé localement. — Cloisonnée par site_id.';

-- scolarite
CREATE OR REPLACE VIEW assistant.t_scolarite AS
SELECT
  "id",
  "montant_scolarite",
  "scolarite_verse",
  "statut_etudiant",
  "scolarite_restante",
  "prise_en_charge_id"
FROM scolarite
WHERE id IN (SELECT scolarite_id FROM etudiant WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_scolarite IS
  'Position financière de scolarité d''un étudiant (montant dû/versé/restant), 7240 lignes mesurées le 2026-08-15. RÔLE CONFIRMÉ par public.vue_position_academique (LEFT JOIN scolarite ON scolarite.id = etudiant.scolarite_id) : TABLE DE RÉFÉRENCE pour le chiffre d''affaires / total encaissé de l''établissement (scolarite_verse), PAS paiement. Relation 1:1 voulue avec etudiant via etudiant.scolarite_id, mais AUCUNE contrainte FOREIGN KEY déclarée sur cette table. — Cloisonnée par rattachement indirect.';

-- seance_edt
CREATE OR REPLACE VIEW assistant.t_seance_edt AS
SELECT
  "id",
  "trame_id",
  "classe_id",
  "matiere_id",
  "enseignant_id",
  "salle_id",
  "intitule",
  "date_seance",
  "heure_debut",
  "heure_fin",
  "type_seance",
  "statut",
  "observations",
  "created_at",
  "updated_at",
  "creneau"
FROM seance_edt;
COMMENT ON VIEW assistant.t_seance_edt IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (planification), pas encore utilisé localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- semestre
CREATE OR REPLACE VIEW assistant.t_semestre AS
SELECT
  "id",
  "nom"
FROM semestre;
COMMENT ON VIEW assistant.t_semestre IS
  'Référentiel des semestres (S1/S2), 2 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- serie_bac
CREATE OR REPLACE VIEW assistant.t_serie_bac AS
SELECT
  "id",
  "nom"
FROM serie_bac;
COMMENT ON VIEW assistant.t_serie_bac IS
  'Référentiel des séries de baccalauréat, 10 lignes mesurées le 2026-08-15. etudiant.serie_bac est un varchar libre, PAS une FOREIGN KEY vers cette table. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- session
CREATE OR REPLACE VIEW assistant.t_session AS
SELECT
  "id",
  "nom",
  "annee_academique_id"
FROM session;
COMMENT ON VIEW assistant.t_session IS
  'Référentiel des sessions d''examen, 1 ligne mesurée le 2026-08-15 — explique pourquoi note.session_id n''a qu''une seule valeur distincte localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- session_caisse
CREATE OR REPLACE VIEW assistant.t_session_caisse AS
SELECT
  "id",
  "caisse_id",
  "caissier_id",
  "date_ouverture",
  "date_fermeture",
  "montant_ouverture",
  "montant_fermeture",
  "statut"
FROM session_caisse
WHERE caisse_id IN (SELECT id FROM caisse WHERE site_id = assistant.site_courant());
COMMENT ON VIEW assistant.t_session_caisse IS
  'Session d''ouverture/fermeture d''une caisse par un caissier (arrêté de caisse), 9 lignes mesurées le 2026-08-15. caissier_id référence utilisateur.id SANS contrainte FOREIGN KEY. — Cloisonnée par rattachement indirect.';

-- site
CREATE OR REPLACE VIEW assistant.t_site AS
SELECT
  "id",
  "nom",
  "adresse"
FROM site;
COMMENT ON VIEW assistant.t_site IS
  'Site physique d''implantation, 3 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- tarif
CREATE OR REPLACE VIEW assistant.t_tarif AS
SELECT
  "id",
  "niveau_id",
  "montant_affecte",
  "montant_non_affecte",
  "toujours_non_affecte",
  "created_at",
  "updated_at",
  "montant_affecte_reinscription"
FROM tarif;
COMMENT ON VIEW assistant.t_tarif IS
  'Barème tarifaire de scolarité pour un niveau donné, 147 lignes mesurées le 2026-08-15. Contrainte UNIQUE(niveau_id) : au plus un tarif par niveau. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- trame_edt
CREATE OR REPLACE VIEW assistant.t_trame_edt AS
SELECT
  "id",
  "annee_academique_id",
  "classe_id",
  "matiere_id",
  "enseignant_id",
  "intitule",
  "jour_semaine",
  "heure_debut",
  "heure_fin",
  "type_seance",
  "date_debut",
  "date_fin",
  "frequence",
  "statut",
  "cree_par",
  "created_at",
  "updated_at"
FROM trame_edt;
COMMENT ON VIEW assistant.t_trame_edt IS
  'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (planification), pas encore utilisé localement. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- type_document
CREATE OR REPLACE VIEW assistant.t_type_document AS
SELECT
  "id",
  "code",
  "libelle",
  "obligatoire",
  "contexte"
FROM type_document;
COMMENT ON VIEW assistant.t_type_document IS
  'Référentiel des types de documents administratifs attendus, 23 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- typefiliere
CREATE OR REPLACE VIEW assistant.t_typefiliere AS
SELECT
  "id",
  "libelle",
  "description"
FROM typefiliere;
COMMENT ON VIEW assistant.t_typefiliere IS
  'Référentiel des types de filière, 2 lignes mesurées le 2026-08-15. Coexiste avec niveau.type_filiere (varchar libre) — ne pas confondre. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- ue
CREATE OR REPLACE VIEW assistant.t_ue AS
SELECT
  "id",
  "libelle",
  "maquette_id",
  "semestre_id",
  "categorie_id",
  "code_ue"
FROM ue;
COMMENT ON VIEW assistant.t_ue IS
  'Unité d''Enseignement, regroupement de matières au sein d''une maquette, 684 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- utilisateur  [retiré : mot_de_passe]
CREATE OR REPLACE VIEW assistant.t_utilisateur AS
SELECT
  "id",
  "nom",
  "email",
  "site_id",
  "role_id",
  "statut",
  "code",
  "ecole_id"
FROM utilisateur
WHERE site_id = assistant.site_courant();
COMMENT ON VIEW assistant.t_utilisateur IS
  'Compte de connexion du personnel (29 lignes mesurées le 2026-08-15). Distinct des comptes étudiants qui vivent dans etudiant. role_id, site_id, ecole_id référencent leurs tables respectives SANS contrainte FOREIGN KEY. — Cloisonnée par site_id. Colonne(s) retirée(s) : mot_de_passe.';

-- ville
CREATE OR REPLACE VIEW assistant.t_ville AS
SELECT
  "id",
  "nom"
FROM ville;
COMMENT ON VIEW assistant.t_ville IS
  'Référentiel des villes, 55 lignes mesurées le 2026-08-15. — NON cloisonnée : référentiel partagé ou structure commune aux sites.';

-- ---------------------------------------------------------------------------
--  Privilèges
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA assistant TO assistant_ro';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistant TO assistant_ro';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON assistant.agent_exclu FROM assistant_ro';
  END IF;
END $$;

COMMIT;

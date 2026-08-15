-- Documentation sémantique de la base pour l'assistante (2026-08-15).
--
-- Objectif : rendre le schéma public compréhensible par l'assistante IA sans
-- qu'elle ait à deviner le sens des tables/colonnes/valeurs, afin d'éviter les
-- doubles comptages, mauvaises jointures, confusions d'identifiants, mauvais
-- filtres de statut, erreurs sur les montants.
--
-- Source de vérité : dictionnaire/*.yml (versionné dans Git). Ce fichier SQL est
-- la traduction en COMMENT ON de ce contenu. En cas de divergence future, le YAML
-- fait foi et cette migration doit être régénérée.
--
-- Portée : uniquement des COMMENT ON TABLE / COMMENT ON COLUMN. Aucune donnée ni
-- structure n'est modifiée. Migration additive et rejouable (COMMENT ON écrase
-- simplement le commentaire précédent s'il existe).
--
-- Base ciblée : LOCALE (db_iipea_20260721) uniquement, comme pour toute migration
-- de ce dépôt. À appliquer avec :
--   node migrations/run.js 2026-08-15_documentation_base_assistante.sql
--
-- etudiant.password et utilisateur.mot_de_passe ne sont volontairement PAS
-- commentées : ne jamais exposer/documenter ces colonnes, même sous forme
-- descriptive.

BEGIN;

-- =========================================================================
-- RANG A — documentation complète
-- =========================================================================

COMMENT ON TABLE public.etudiant IS
  'Position académique et administrative COURANTE d''un étudiant (1 ligne par étudiant, mesuré 7201 lignes le 2026-08-15). '
  'PAS un historique : voir inscription_annuelle et historique_inscription pour l''historique par année, et public.vue_position_academique comme SEULE source de lecture recommandée pour les données historiques. '
  'Beaucoup de colonnes de type référence (site_id, annee_academique_id, groupe_id, niveau_id, document_id, scolarite_id, curcus_id, id_filiere) n''ont AUCUNE contrainte FOREIGN KEY déclarée.';

COMMENT ON COLUMN public.etudiant.matricule IS
  'DOUBLONS CONFIRMÉS : 23 valeurs dupliquées sur 611 lignes (~8,5% des 7201 lignes, mesuré le 2026-08-15). Ne JAMAIS utiliser comme identifiant unique.';

COMMENT ON COLUMN public.etudiant.matricule_iipea IS
  'Identifiant interne à privilégier pour identifier un étudiant : 7201/7201 valeurs distinctes observées (unique en pratique), bien qu''aucune contrainte UNIQUE ne soit déclarée en base.';

COMMENT ON COLUMN public.etudiant.code_unique IS
  'Malgré son nom, PAS strictement unique : 43 valeurs dupliquées sur 88 lignes (mesuré le 2026-08-15). Usage métier réel à confirmer.';

COMMENT ON COLUMN public.etudiant.code_paiement IS
  'Quasiment NON ALIMENTÉE au niveau étudiant (1 valeur non nulle sur 7201 lignes). Voir inscription_annuelle.code_paiement, qui semble être la colonne réellement utilisée.';

COMMENT ON COLUMN public.etudiant.standing IS
  'RÈGLE MÉTIER : pour les effectifs étudiants, filtrer WHERE standing = ''Inscrit''. Valeurs observées : Inscrit (7200), en attente (1).';

COMMENT ON COLUMN public.etudiant.statut_scolaire IS
  'Valeurs observées : Affecté (5544), Non affecté (1657). Sens métier précis (affectation à un groupe/classe ?) à confirmer, à distinguer de standing.';

COMMENT ON COLUMN public.etudiant.source_inscription IS
  'Canal de création du dossier : ''agent'' (saisie interne Scolarité, 7200 lignes) ou ''web'' (portail public d''admission, 1 ligne).';

COMMENT ON COLUMN public.etudiant.password IS
  'NE JAMAIS EXPOSER NI DOCUMENTER LE CONTENU, même haché.';

COMMENT ON COLUMN public.etudiant.scolarite_id IS
  'Référence NON contrainte par une FOREIGN KEY vers scolarite.id. Relation 1:1 voulue (confirmée par le LEFT JOIN de public.vue_position_academique) mais avec écarts observés : 2 valeurs réutilisées par plusieurs étudiants, 41 lignes de scolarite orphelines (mesuré le 2026-08-15).';

COMMENT ON COLUMN public.etudiant.groupe_id IS
  'Référence NON contrainte par une FOREIGN KEY vers groupe.id. 7 étudiants sur 7201 référencent un groupe_id inexistant (mesuré le 2026-08-15).';

COMMENT ON COLUMN public.etudiant.ip_ministere IS
  'Sens métier exact non déductible du schéma seul (A CONFIRMER). 6042/7201 lignes alimentées.';

COMMENT ON COLUMN public.etudiant.numero_table IS
  'Alimentée pour environ 43% des étudiants seulement (3067/7201, mesuré le 2026-08-15). Usage exact (table d''examen ?) à confirmer.';

COMMENT ON TABLE public.paiement IS
  'Un encaissement individuel via le module Caisse (11734 lignes mesurées le 2026-08-15). '
  'ATTENTION — NE COUVRE PAS tout l''historique des règlements : les montants repris à la mise en service n''y figurent pas. '
  'SUM(paiement.montant) N''EST PAS le chiffre d''affaires / total des recettes de l''établissement. La RÉFÉRENCE pour ''chiffre d''affaires'', ''recettes'', ''total encaissé'' est scolarite.scolarite_verse (voir public.vue_position_academique). '
  'À utiliser pour l''activité de caisse (encaissements du jour/du mois, par caissier, par mode de paiement). '
  'etudiant_id et recu_id référencent etudiant/recu SANS contrainte FOREIGN KEY (fiable en pratique : 0 orphelin observé).';

COMMENT ON COLUMN public.paiement.montant IS
  'Montant réellement encaissé via le module Caisse UNIQUEMENT. Ne déduit pas les prises en charge (mouvement séparé, voir prise_en_charge.montant_reduction). Ne pas sommer pour un chiffre d''affaires global : utiliser scolarite.scolarite_verse.';

COMMENT ON COLUMN public.paiement.statut IS
  'Pour les recettes de caisse : filtrer WHERE statut = ''VALIDE''. Seule valeur observée localement (11734/11734, mesuré le 2026-08-15) ; la colonne existe pour distinguer d''éventuels paiements non validés/annulés.';

COMMENT ON COLUMN public.paiement.methode IS
  'GRAPHIES INCOHÉRENTES OBSERVÉES : ''especes'' (11722) et ''Espèces'' (8) désignent la même méthode avec une casse/accentuation différente ; un GROUP BY brut double artificiellement le comptage. Autres valeurs : ''Mobile Money'' (2), ''Wave'' (2). Mesuré le 2026-08-15, non corrigé (hors périmètre).';

COMMENT ON COLUMN public.paiement.type_frais IS
  'COLONNE NON ALIMENTÉE : 100% NULL sur 11734 lignes (mesuré le 2026-08-15). Ne pas s''appuyer dessus pour distinguer la nature d''un frais.';

COMMENT ON COLUMN public.paiement.recu_id IS
  'Référence NON contrainte par une FOREIGN KEY vers recu.id. Relation 1:1 observée (11734 paiements pour 11734 recu_id distincts) ; environ 110 des 11844 reçus ne sont référencés par aucun paiement.';

COMMENT ON COLUMN public.paiement.etudiant_id IS
  'Référence NON contrainte par une FOREIGN KEY vers etudiant.id. 0 orphelin observé sur 11734 lignes (mesuré le 2026-08-15).';

COMMENT ON TABLE public.note IS
  'Une évaluation d''un étudiant dans un enseignement donné (105353 lignes mesurées le 2026-08-15). '
  'AUCUNE clé primaire ni contrainte FOREIGN KEY déclarée sur cette table (seulement 2 contraintes CHECK sur les plages de valeurs). '
  'Les colonnes note1/note2/partiel ne sont pas toutes pertinentes pour chaque matière : voir matiere.type_evaluation avant tout calcul de moyenne.';

COMMENT ON COLUMN public.note.note1 IS
  'Plage 0-20 (contrainte CHECK). Pertinence conditionnée par matiere.type_evaluation de l''enseignement concerné. 99,88% de lignes alimentées.';

COMMENT ON COLUMN public.note.note2 IS
  'Plage 0-20 (contrainte CHECK). Pertinence conditionnée par matiere.type_evaluation. 99,35% de lignes alimentées.';

COMMENT ON COLUMN public.note.partiel IS
  'Plage 0-20 (contrainte CHECK). Pertinence conditionnée par matiere.type_evaluation. 98,49% de lignes alimentées.';

COMMENT ON COLUMN public.note.moyenne IS
  'Alimentée à 100%. Formule de calcul exacte à partir de note1/note2/partiel non déductible du schéma seul (A CONFIRMER).';

COMMENT ON COLUMN public.note.session_id IS
  'Référence NON contrainte vers session.id. Alimentée à 100% mais avec UNE SEULE valeur distincte localement (la table session ne compte qu''une ligne, mesuré le 2026-08-15) : non discriminante actuellement.';

COMMENT ON COLUMN public.note.fichier_source IS
  'Alimentée à 100% (105353/105353), 2234 valeurs distinctes. Vraisemblablement un nom de fichier d''import en masse (voir controllers/chargementNote.js). Sens métier exact et fiabilité pour l''audit A CONFIRMER.';

COMMENT ON COLUMN public.note.coefficient IS
  'Plage 0-100 (contrainte CHECK), défaut 1.0. Relation avec matiere.coefficient (colonne homonyme) à clarifier (A CONFIRMER).';

COMMENT ON TABLE public.inscription_annuelle IS
  'Position académique d''un étudiant POUR UNE ANNÉE ACADÉMIQUE DONNÉE (snapshot annuel), 7200 lignes mesurées le 2026-08-15. '
  'RÈGLE ANTI DOUBLE-COMPTAGE : contrainte UNIQUE(etudiant_id, annee_academique_id) — une seule ligne par étudiant et par année. '
  'Les données locales proviennent d''une migration technique (type_evenement = ''migration_position_courante''/''migration_historique''), pas encore du flux normal de réinscription.';

COMMENT ON COLUMN public.inscription_annuelle.curcus_id IS
  'COLONNE NON ALIMENTÉE : 100% NULL sur 7200 lignes (mesuré le 2026-08-15), malgré une contrainte FOREIGN KEY déclarée vers curcus.id.';

COMMENT ON COLUMN public.inscription_annuelle.standing IS
  '2 lignes ont une chaîne vide '''' plutôt que NULL ou une valeur métier (mesuré le 2026-08-15) — distinguer standing = '''' de standing IS NULL.';

COMMENT ON COLUMN public.inscription_annuelle.code_paiement IS
  'Semble être la colonne réellement utilisée pour le code de paiement (à comparer avec etudiant.code_paiement, quasiment vide).';

COMMENT ON COLUMN public.inscription_annuelle.type_evenement IS
  'Défaut ''reinscription'', mais aucune ligne locale ne porte cette valeur : les 7200 lignes observées proviennent d''une migration technique (migration_position_courante : 7198, migration_historique : 2, mesuré le 2026-08-15).';

COMMENT ON COLUMN public.inscription_annuelle.matieres_a_reprendre IS
  'jsonb — structure exacte non déductible du schéma seul (A CONFIRMER).';

COMMENT ON COLUMN public.inscription_annuelle.moyenne_annuelle IS
  'Formule de calcul exacte à partir de moyenne_s1/moyenne_s2 non déductible du schéma seul (A CONFIRMER).';

COMMENT ON TABLE public.utilisateur IS
  'Compte de connexion du personnel (29 lignes mesurées le 2026-08-15). Distinct des comptes étudiants qui vivent dans etudiant. '
  'role_id, site_id, ecole_id référencent leurs tables respectives SANS contrainte FOREIGN KEY.';

COMMENT ON COLUMN public.utilisateur.mot_de_passe IS
  'NE JAMAIS EXPOSER NI DOCUMENTER LE CONTENU, même haché.';

COMMENT ON COLUMN public.utilisateur.statut IS
  'Pour les comptes actifs : WHERE statut = ''active''. Valeurs observées : active (22), desactive (7), mesuré le 2026-08-15.';

COMMENT ON TABLE public.scolarite IS
  'Position financière de scolarité d''un étudiant (montant dû/versé/restant), 7240 lignes mesurées le 2026-08-15. '
  'RÔLE CONFIRMÉ par public.vue_position_academique (LEFT JOIN scolarite ON scolarite.id = etudiant.scolarite_id) : TABLE DE RÉFÉRENCE pour le chiffre d''affaires / total encaissé de l''établissement (scolarite_verse), PAS paiement. '
  'Relation 1:1 voulue avec etudiant via etudiant.scolarite_id, mais AUCUNE contrainte FOREIGN KEY déclarée sur cette table.';

COMMENT ON COLUMN public.scolarite.montant_scolarite IS
  'Montant total dû au titre de la scolarité. Relation avec inscription_annuelle.montant_scolarite et tarif à clarifier (A CONFIRMER).';

COMMENT ON COLUMN public.scolarite.scolarite_verse IS
  'Cumul RÉELLEMENT versé par l''étudiant, toutes origines confondues (y compris l''historique repris hors module Caisse). RÉFÉRENCE OFFICIELLE pour ''chiffre d''affaires''/''recettes''/''total encaissé'', à privilégier sur SUM(paiement.montant) qui sous-estime largement ce total.';

COMMENT ON COLUMN public.scolarite.scolarite_restante IS
  'Solde restant dû. Mécanisme de mise à jour (recalcul automatique ou champ maintenu séparément) non déductible du schéma seul (A CONFIRMER).';

COMMENT ON COLUMN public.scolarite.statut_etudiant IS
  'Indicateur de solde : WHERE statut_etudiant = ''SOLDE'' pour les dossiers soldés. Valeurs observées : SOLDE (6288), NON_SOLDE (948), en attente (4), mesuré le 2026-08-15.';

COMMENT ON TABLE public.recu IS
  'Justificatif d''encaissement associé à un paiement (11844 lignes mesurées le 2026-08-15). '
  'AUCUNE CONTRAINTE DU TOUT sur cette table : ni PRIMARY KEY, ni UNIQUE, ni FOREIGN KEY, ni même un index. Environ 110 reçus ne sont référencés par aucun paiement.';

COMMENT ON COLUMN public.recu.numero_recu IS
  'Numéro affiché à l''étudiant : 11844/11844 valeurs distinctes localement, mais SANS contrainte d''unicité en base.';

COMMENT ON TABLE public.prise_en_charge IS
  'Réduction ou prise en charge institutionnelle des frais de scolarité (bourse, convention entreprise), 224 lignes mesurées le 2026-08-15. Mouvement DISTINCT des paiements réels (ne pas combiner avec paiement.montant pour un coût total).';

COMMENT ON COLUMN public.prise_en_charge.statut IS
  'RÈGLE MÉTIER : seules les prises en charge au statut ''valide'' (minuscule) réduisent réellement le dû. '
  'PIÈGE : la valeur par défaut de la colonne est ''EN_ATTENTE'' (majuscules) alors que la contrainte CHECK n''autorise que du minuscule (''en_attente'',''initiee'',''valide'',''refuse'') — incohérence de casse observée dans le schéma, non corrigée à cette étape. Valeurs observées : valide (223), en_attente (1), mesuré le 2026-08-15.';

COMMENT ON COLUMN public.prise_en_charge.etudiant_id IS
  'NOT NULL mais SANS contrainte FOREIGN KEY vers etudiant.id.';

COMMENT ON COLUMN public.prise_en_charge.montant_reduction IS
  'Mouvement distinct de paiement.montant : ne pas les additionner/soustraire sans discernement pour un calcul de coût réel.';

COMMENT ON TABLE public.session_caisse IS
  'Session d''ouverture/fermeture d''une caisse par un caissier (arrêté de caisse), 9 lignes mesurées le 2026-08-15. caissier_id référence utilisateur.id SANS contrainte FOREIGN KEY.';

COMMENT ON COLUMN public.session_caisse.statut IS
  'Pour la session de caisse active : WHERE statut = ''OUVERTE''. Valeurs observées : FERMEE (6), OUVERTE (3), mesuré le 2026-08-15.';

COMMENT ON TABLE public.anneeacademique_site IS
  'Ouverture d''une année académique pour un site donné, 2 lignes mesurées le 2026-08-15. '
  'RÈGLE MÉTIER GARANTIE PAR LE SCHÉMA (index unique partiel) : au plus une ligne à l''état ''en cour'' par site.';

COMMENT ON COLUMN public.anneeacademique_site.etat IS
  'Pour l''année académique active d''un site : WHERE etat = ''en cour'' (orthographe exacte : sans ''s'' final, pas ''en cours''). Valeurs observées : terminée (1), en cour (1), mesuré le 2026-08-15.';

-- =========================================================================
-- RANG B — documentation allégée (ajout : historique_inscription, hors liste
-- d'origine, ajoutée le 2026-08-15 à la demande explicite de l'utilisateur
-- car centrale à l'architecture d'historisation, voir CLAUDE.md)
-- =========================================================================

COMMENT ON TABLE public.historique_inscription IS
  'Position académique FIGÉE d''un étudiant pour une année académique clôturée (9 lignes mesurées le 2026-08-15), alimentée à chaque réinscription/clôture. Combinée à etudiant par public.vue_position_academique (UNION ALL, filtrée sur type_evenement=''cloture'') : SEULE source de lecture recommandée pour les données historiques. '
  'ATTENTION — le commentaire existant sur assistant.v_activite_agents affirme que cette table est vide : c''est désormais FAUX (9 lignes), commentaire obsolète signalé pour action future.';

COMMENT ON COLUMN public.historique_inscription.type_evenement IS
  'Valeurs observées : cloture (8), reinscription (1). Seul ''cloture'' est repris par vue_position_academique.';

COMMENT ON TABLE public.classe IS
  'Classe pédagogique (année académique x niveau x filière), 155 lignes mesurées le 2026-08-15. Recréée chaque année académique (filiere reste permanente, voir CLAUDE.md).';

COMMENT ON TABLE public.groupe IS
  'Groupe d''étudiants au sein d''une classe, 216 lignes mesurées le 2026-08-15. Référencé par etudiant.groupe_id SANS contrainte FOREIGN KEY (7 orphelins observés, voir etudiant).';

COMMENT ON TABLE public.niveau IS
  'Niveau d''études (filière x année académique x site), 148 lignes mesurées le 2026-08-15. Recréé chaque année académique comme classe/tarif/maquette.';

COMMENT ON TABLE public.filiere IS
  'Filière de formation, PERMANENTE d''une année sur l''autre (contrairement à classe/niveau/tarif/maquette), 29 lignes mesurées le 2026-08-15.';

COMMENT ON TABLE public.matiere IS
  'Matière (ECUE) rattachée à une UE, 1701 lignes mesurées le 2026-08-15.';

COMMENT ON COLUMN public.matiere.type_evaluation IS
  'RÈGLE MÉTIER CENTRALE pour éviter les erreurs de moyenne : indique quelles colonnes de note (note1/note2/partiel) sont pertinentes pour cette matière (enum : note_1_note_2_partiel, note_1_partiel, note_2_partiel, partiel_only, note_1_note_2, note_1_only, note_2_only). Vérifier avant tout calcul de moyenne à partir de note.';

COMMENT ON TABLE public.ue IS
  'Unité d''Enseignement, regroupement de matières au sein d''une maquette, 684 lignes mesurées le 2026-08-15.';

COMMENT ON TABLE public.enseignement IS
  'Rattachement (professeur x matière x groupe) pour une année académique, 1981 lignes mesurées le 2026-08-15. Contrainte UNIQUE(professeur_id, matiere_id, groupe_id, annee_academique).';

COMMENT ON COLUMN public.enseignement.annee_academique IS
  'Stockée en texte libre (varchar), PAS une FOREIGN KEY vers anneeacademique.id : risque de désynchronisation orthographique.';

COMMENT ON TABLE public.tarif IS
  'Barème tarifaire de scolarité pour un niveau donné, 147 lignes mesurées le 2026-08-15. Contrainte UNIQUE(niveau_id) : au plus un tarif par niveau.';

COMMENT ON TABLE public.caisse IS
  'Caisse physique/logique d''un site, point d''encaissement des paiements, 3 lignes mesurées le 2026-08-15.';

COMMENT ON TABLE public.mouvement_stock IS
  'Mouvement de stock d''un accessoire (réception/distribution/ajustement/transfert), 6 lignes mesurées le 2026-08-15 (module peu utilisé localement).';

COMMENT ON TABLE public.memoire IS
  'Dépôt de mémoire de fin d''études d''un étudiant pour une année académique, 461 lignes mesurées le 2026-08-15, avec circuit de validation (statut).';

COMMENT ON TABLE public.document_etudiant IS
  'Suivi de fourniture d''un document administratif (par type_document) par un étudiant, 157 lignes mesurées le 2026-08-15. Contrainte UNIQUE(etudiant_id, type_document_id).';

COMMENT ON TABLE public.professeur IS
  'Enseignant utilisé par le module notes/enseignements historique (enseignement.professeur_id), 115 lignes mesurées le 2026-08-15. NE PAS CONFONDRE avec la table enseignant (module RH plus récent, vide localement).';

COMMENT ON TABLE public.maquette IS
  'Maquette pédagogique (filière x niveau x année académique), regroupant les UE, 118 lignes mesurées le 2026-08-15.';

COMMENT ON TABLE public.emploi_du_temps IS
  'Fichier d''emploi du temps uploadé pour un groupe (dépôt simple), 160 lignes mesurées le 2026-08-15. NE PAS CONFONDRE avec seance_edt/trame_edt (module Enseignants, planification structurée, vide localement).';

COMMENT ON TABLE public.kit IS
  'Frais/dépôt de kit scolaire d''un étudiant pour une année académique, 7314 lignes mesurées le 2026-08-15. Certaines années peuvent être suspendues pour ce module (variable KIT_ANNEES_SUSPENDUES).';

COMMENT ON TABLE public.document IS
  'Checklist des pièces administratives d''un dossier étudiant à l''admission (4 colonnes texte), 9395 lignes mesurées le 2026-08-15, référencée par etudiant.document_id.';

COMMENT ON COLUMN public.document.extrait_naissance IS
  'Colonne TEXTE (''oui''/''non''), PAS un boolean : WHERE extrait_naissance = ''oui'', pas = true. Valeurs observées : oui (9382), non (13), mesuré le 2026-08-15.';

-- =========================================================================
-- RANG C — description courte (référentiels stables)
-- =========================================================================

COMMENT ON TABLE public.anneeacademique IS 'Référentiel des années académiques (ex. ''2025-2026''), 2 lignes mesurées le 2026-08-15. Référencée par de très nombreuses tables (paiement, etudiant, niveau, classe, inscription_annuelle...). Contrainte UNIQUE(annee). Absente du rang A/B/C/D d''origine, ajoutée en rang C.';

COMMENT ON TABLE public.pays IS 'Référentiel des pays (nationalité, code ISO), 195 lignes mesurées le 2026-08-15.';
COMMENT ON TABLE public.ville IS 'Référentiel des villes, 55 lignes mesurées le 2026-08-15.';
COMMENT ON TABLE public.serie_bac IS 'Référentiel des séries de baccalauréat, 10 lignes mesurées le 2026-08-15. etudiant.serie_bac est un varchar libre, PAS une FOREIGN KEY vers cette table.';
COMMENT ON TABLE public.annee_bac IS 'Référentiel des années d''obtention du bac, 27 lignes mesurées le 2026-08-15. etudiant.annee_bac est un varchar libre, PAS une FOREIGN KEY vers cette table.';
COMMENT ON TABLE public.type_document IS 'Référentiel des types de documents administratifs attendus, 23 lignes mesurées le 2026-08-15.';
COMMENT ON TABLE public.typefiliere IS 'Référentiel des types de filière, 2 lignes mesurées le 2026-08-15. Coexiste avec niveau.type_filiere (varchar libre) — ne pas confondre.';
COMMENT ON TABLE public.curcus IS 'Référentiel des types de parcours, 3 lignes mesurées le 2026-08-15. curcus_id est décliné en FOREIGN KEY sur plusieurs tables mais reste NON ALIMENTÉ sur inscription_annuelle localement.';
COMMENT ON TABLE public.semestre IS 'Référentiel des semestres (S1/S2), 2 lignes mesurées le 2026-08-15.';
COMMENT ON TABLE public.session IS 'Référentiel des sessions d''examen, 1 ligne mesurée le 2026-08-15 — explique pourquoi note.session_id n''a qu''une seule valeur distincte localement.';
COMMENT ON TABLE public.role IS 'Référentiel des rôles applicatifs, 10 lignes mesurées le 2026-08-15. Référencé par utilisateur.role_id SANS contrainte FOREIGN KEY.';
COMMENT ON TABLE public.site IS 'Site physique d''implantation, 3 lignes mesurées le 2026-08-15.';
COMMENT ON TABLE public.ecole IS 'École au sein de l''établissement, 5 lignes mesurées le 2026-08-15.';
COMMENT ON TABLE public.departement IS 'Département pédagogique au sein d''une école, 5 lignes mesurées le 2026-08-15. Contrainte UNIQUE(ecole_id, nom).';
COMMENT ON TABLE public.categorie IS 'Référentiel des catégories d''UE, 1 ligne mesurée le 2026-08-15 (non représentatif).';
COMMENT ON TABLE public.accessoire IS 'Article du stock scolaire, 4 lignes mesurées le 2026-08-15.';
COMMENT ON TABLE public.emplacement_stock IS 'Emplacement physique de stockage rattaché à un site, 3 lignes mesurées le 2026-08-15.';
COMMENT ON TABLE public.fournisseur IS 'Fournisseur pour les commandes de stock, 1 ligne mesurée le 2026-08-15 (module peu utilisé).';
COMMENT ON TABLE public.etablissement_origine IS 'Référentiel des établissements d''origine des étudiants, 1226 lignes mesurées le 2026-08-15. ATTENTION : etudiant.etablissement_origine est un champ TEXTE LIBRE, PAS une FOREIGN KEY vers cette table malgré le nom identique.';
COMMENT ON TABLE public.commande_fournisseur IS 'Commande passée à un fournisseur, 1 ligne mesurée le 2026-08-15 (module peu utilisé).';
COMMENT ON TABLE public.ligne_commande_fournisseur IS 'Ligne de détail (accessoire x quantité) d''une commande fournisseur, 4 lignes mesurées le 2026-08-15.';
COMMENT ON TABLE public.reception_fournisseur IS 'Réception physique d''une commande fournisseur, 2 lignes mesurées le 2026-08-15.';

-- =========================================================================
-- RANG D — tables vides et table technique
-- =========================================================================

COMMENT ON TABLE public.candidature_enseignant IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), introduit par migrations/2026-08-11_module_enseignants.sql, pas encore utilisé localement.';
COMMENT ON TABLE public.candidature_diplome IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement.';
COMMENT ON TABLE public.candidature_filiere IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement.';
COMMENT ON TABLE public.offre_emploi_enseignant IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement.';
COMMENT ON TABLE public.besoin_enseignant IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement.';
COMMENT ON TABLE public.enseignant IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement. NE PAS CONFONDRE avec professeur (module historique notes/enseignements, 115 lignes).';
COMMENT ON TABLE public.contrat_enseignant IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement.';
COMMENT ON TABLE public.contrat_classe IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement.';
COMMENT ON TABLE public.affectation_charge_pedagogique IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (RH), pas encore utilisé localement.';
COMMENT ON TABLE public.salle IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (planification), pas encore utilisé localement.';
COMMENT ON TABLE public.trame_edt IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (planification), pas encore utilisé localement.';
COMMENT ON TABLE public.seance_edt IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module Enseignants (planification), pas encore utilisé localement.';
COMMENT ON TABLE public.demande_equivalence IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module équivalence de diplôme, non utilisé localement (raison exacte A CONFIRMER).';
COMMENT ON TABLE public.demande_equivalence_historique IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module équivalence de diplôme, non utilisé localement.';
COMMENT ON TABLE public.document_equivalence IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module équivalence de diplôme, non utilisé localement.';
COMMENT ON TABLE public.distribution IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module stock, aucune distribution enregistrée localement (module globalement peu alimenté : accessoire 4 lignes, fournisseur 1 ligne).';
COMMENT ON TABLE public.ligne_distribution IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Module stock, voir distribution.';
COMMENT ON TABLE public.permission IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Les rôles semblent gérés directement via utilisateur.role_id/role plutôt que via ce système de permissions granulaires (A CONFIRMER).';
COMMENT ON TABLE public.rolepermission IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Voir permission.';
COMMENT ON TABLE public.assistant_google_compte IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Migration très récente (2026-08-12e_assistant_google.sql) : aucun compte Google configuré localement.';
COMMENT ON TABLE public.assistant_reglages IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Migration très récente (2026-08-13d_assistant_reglages.sql) : aucun réglage de site initialisé localement.';
COMMENT ON TABLE public.decoupage_groupe IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Fonctionnalité de répartition automatique de groupes, jamais déclenchée localement (A CONFIRMER).';
COMMENT ON TABLE public.historique_operations_admin IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Aucun changement de filière/parcours/cycle exceptionnel (hors réinscription) enregistré localement, voir CLAUDE.md.';
COMMENT ON TABLE public.resultat IS 'TABLE VIDE (0 ligne mesurée le 2026-08-15). Ses colonnes (moyenne, decision, etudiant_id, session_id) font doublon fonctionnel avec inscription_annuelle.moyenne_annuelle/decision_annuelle — hypothèse d''une table supplantée, NON CONFIRMÉE. Ne pas s''appuyer dessus.';

COMMENT ON TABLE public.etudiant_email_backup IS
  'TABLE TECHNIQUE NON VIDE (1058 lignes mesurées le 2026-08-15), sans clé primaire ni contrainte déclarée. Sauvegarde ponctuelle probable des emails étudiants avant une opération de correction/migration de données (raison et date exactes A CONFIRMER, non déductibles du schéma). '
  'Contient une colonne email : DONNÉE PERSONNELLE, ne jamais en recopier le contenu. Aucune trace d''utilisation applicative trouvée dans routes/controllers : probablement obsolète, ne pas utiliser comme source des emails actuels (utiliser etudiant.email).';

COMMIT;

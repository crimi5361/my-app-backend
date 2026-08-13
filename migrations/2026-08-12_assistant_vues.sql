-- ============================================================================
--  Assistant Fondateur — couche de lecture (2026-08-12)
--
--  Objectif : permettre au modèle de répondre à n'importe quelle question en
--  écrivant du SQL, sans qu'il puisse jamais écrire, ni voir de donnée sensible,
--  ni sortir du périmètre du fondateur connecté.
--
--  Trois garanties, dans cet ordre d'importance :
--
--   1. LE RÔLE  — assistant_ro (créé par migrations/setup-role-assistant.js) n'a
--      que USAGE sur ce schéma et SELECT sur ces vues. Aucun privilège d'écriture
--      n'existe : INSERT/UPDATE/DELETE/DDL sont impossibles par construction, pas
--      par vérification. C'est la seule garantie qui ne dépend d'aucun code applicatif.
--
--   2. LES VUES — le rôle n'a AUCUN accès au schéma public. Il ne peut donc pas
--      lire utilisateur.mot_de_passe, etudiant.password, ni les données
--      personnelles (téléphones, emails, parents, pièces d'identité). Ces colonnes
--      ne sont simplement pas exposées ici.
--
--   3. LE CLOISONNEMENT — site et école sont filtrés DANS la définition des vues,
--      à partir de variables de session posées par le serveur depuis le JWT. Le
--      modèle ne peut pas les contourner : elles ne sont pas des paramètres de sa
--      requête, elles font partie de la vue. Si la variable n'est pas posée, les
--      vues ne renvoient RIEN (échec fermé) — voir assistant.site_courant().
--
--  Migration additive : aucun ALTER ni DROP sur une table existante.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS assistant;

COMMENT ON SCHEMA assistant IS
  'Couche de lecture seule exposée à l''Assistant Fondateur. Ne jamais y placer de donnée personnelle.';

-- ---------------------------------------------------------------------------
--  Cloisonnement : lu depuis les variables de session, jamais depuis la requête
--
--  `true` en 2e argument de current_setting = ne pas lever d'erreur si absent.
--  Absent => NULL => toute comparaison `site_id = NULL` est fausse => 0 ligne.
--  L'échec est donc fermé : un oubli côté serveur ne fuite rien, il vide la vue.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assistant.site_courant() RETURNS int
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('assistant.site_id', true), '')::int $$;

CREATE OR REPLACE FUNCTION assistant.ecole_courante() RETURNS int
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('assistant.ecole_id', true), '')::int $$;

COMMENT ON FUNCTION assistant.site_courant() IS
  'Site du fondateur connecté, posé par le serveur via SET LOCAL. NULL => aucune ligne.';
COMMENT ON FUNCTION assistant.ecole_courante() IS
  'École du fondateur connecté. NULL => vue sur toutes les écoles du site.';

-- ---------------------------------------------------------------------------
--  1. Étudiants — une ligne par étudiant et par année académique
--     PII exclue : nom, prénoms, téléphone, email, parents, adresses,
--     pièces d'identité, photo. Le matricule est conservé : c'est la clé métier
--     qui permet au fondateur de retrouver un dossier dans l'ERP.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_etudiants AS
SELECT
  e.matricule,
  aa.annee                          AS annee_academique,
  e.annee_academique_id,
  ec.nom                            AS ecole,
  f.nom                             AS filiere,
  f.sigle                           AS filiere_sigle,
  n.libelle                         AS niveau,
  cu.type_parcours                  AS cursus,
  e.sexe,
  e.nationalite,
  e.standing,                       -- 'Inscrit' | 'en attente' | ...
  e.statut_scolaire,
  e.statut_paiement,
  e.source_inscription,
  e.date_inscription,
  e.montant_scolarite,
  e.scolarite_verse,
  e.scolarite_restante
FROM public.vue_position_academique e
LEFT JOIN public.anneeacademique aa ON aa.id = e.annee_academique_id
LEFT JOIN public.filiere f          ON f.id = e.id_filiere
LEFT JOIN public.departement d      ON d.id = f.departement_id
LEFT JOIN public.ecole ec           ON ec.id = d.ecole_id
LEFT JOIN public.niveau n           ON n.id = e.niveau_id
LEFT JOIN public.curcus cu          ON cu.id = e.curcus_id
WHERE e.site_id = assistant.site_courant()
  AND (assistant.ecole_courante() IS NULL OR ec.id = assistant.ecole_courante());

COMMENT ON VIEW assistant.v_etudiants IS
  'Étudiants du site, avec leur position financière. Une ligne par étudiant et par année. '
  'standing = ''Inscrit'' pour les inscriptions effectives. '
  'Pour un effectif : COUNT(*) WHERE standing = ''Inscrit''. '
  'Pour le chiffre d''affaires attendu : SUM(montant_scolarite) ; encaissé : SUM(scolarite_verse) ; '
  'reste à recouvrer : SUM(scolarite_restante).';

-- ---------------------------------------------------------------------------
--  2. Paiements — le flux réellement encaissé, ligne par ligne
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_paiements AS
SELECT
  p.date_paiement,
  p.montant,
  p.methode,
  p.type_frais,
  p.statut,
  p.reference_transaction,
  p.effectue_par                    AS encaisse_par,
  aa.annee                          AS annee_academique,
  p.annee_academique_id,
  ca.libelle                        AS caisse,
  ca.code                           AS caisse_code,
  et.matricule,
  ec.nom                            AS ecole,
  f.nom                             AS filiere,
  n.libelle                         AS niveau
FROM public.paiement p
JOIN public.caisse ca               ON ca.id = p.caisse_id
LEFT JOIN public.anneeacademique aa ON aa.id = p.annee_academique_id
LEFT JOIN public.etudiant et        ON et.id = p.etudiant_id
LEFT JOIN public.filiere f          ON f.id = et.id_filiere
LEFT JOIN public.departement d      ON d.id = f.departement_id
LEFT JOIN public.ecole ec           ON ec.id = d.ecole_id
LEFT JOIN public.niveau n           ON n.id = et.niveau_id
WHERE ca.site_id = assistant.site_courant()
  AND (assistant.ecole_courante() IS NULL OR ec.id = assistant.ecole_courante());

COMMENT ON VIEW assistant.v_paiements IS
  'Encaissements réels, une ligne par paiement. Pour une évolution mensuelle : '
  'GROUP BY date_trunc(''month'', date_paiement). Distinct de v_etudiants.scolarite_verse '
  'qui est un cumul par étudiant.';

-- ---------------------------------------------------------------------------
--  3. Prises en charge (bourses, réductions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_prises_en_charge AS
SELECT
  pec.reference,
  pec.type_pec,
  pec.pourcentage_reduction,
  pec.montant_reduction,
  pec.statut,                       -- 'valide' | 'en_attente' | 'refuse'
  pec.date_demande,
  pec.date_validation,
  aa.annee                          AS annee_academique,
  pec.annee_academique_id,
  et.matricule,
  ec.nom                            AS ecole,
  f.nom                             AS filiere,
  n.libelle                         AS niveau
FROM public.prise_en_charge pec
JOIN public.etudiant et             ON et.id = pec.etudiant_id
LEFT JOIN public.anneeacademique aa ON aa.id = pec.annee_academique_id
LEFT JOIN public.filiere f          ON f.id = et.id_filiere
LEFT JOIN public.departement d      ON d.id = f.departement_id
LEFT JOIN public.ecole ec           ON ec.id = d.ecole_id
LEFT JOIN public.niveau n           ON n.id = et.niveau_id
WHERE et.site_id = assistant.site_courant()
  AND (assistant.ecole_courante() IS NULL OR ec.id = assistant.ecole_courante());

COMMENT ON VIEW assistant.v_prises_en_charge IS
  'Réductions et bourses accordées. Seules celles au statut ''valide'' réduisent réellement le dû.';

-- ---------------------------------------------------------------------------
--  4. Sessions de caisse — l'activité quotidienne des guichets
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_sessions_caisse AS
SELECT
  ca.code                           AS caisse_code,
  ca.libelle                        AS caisse,
  ca.statut                         AS caisse_statut,
  sc.date_ouverture,
  sc.date_fermeture,
  sc.montant_ouverture,
  sc.montant_fermeture,
  sc.statut                         AS session_statut,   -- 'OUVERTE' | 'FERMEE'
  u.nom                             AS caissier
FROM public.caisse ca
LEFT JOIN public.session_caisse sc  ON sc.caisse_id = ca.id
LEFT JOIN public.utilisateur u      ON u.id = sc.caissier_id
WHERE ca.site_id = assistant.site_courant();

COMMENT ON VIEW assistant.v_sessions_caisse IS
  'Caisses du site et leurs sessions. session_statut = ''OUVERTE'' pour les caisses actuellement ouvertes.';

-- ---------------------------------------------------------------------------
--  5. Enseignants et contrats (module Gestion des Enseignants)
--     Les enseignants sont des contreparties contractuelles que le fondateur
--     pilote : nom et matricule sont conservés, coordonnées et CV exclus.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_enseignants AS
SELECT
  ens.matricule,
  ens.nom,
  ens.prenoms,
  ens.grade,
  ens.specialite,
  ens.date_recrutement,
  ens.statut                        AS statut_enseignant,
  ec.nom                            AS ecole,
  aa.annee                          AS annee_academique,
  ct.annee_academique_id,
  ct.type_contrat,
  ct.taux_horaire,
  ct.volume_horaire_global,
  (ct.taux_horaire * ct.volume_horaire_global) AS cout_previsionnel,
  ct.statut                         AS statut_contrat,
  ct.date_debut,
  ct.date_fin,
  (SELECT COUNT(*) FROM public.contrat_classe cc WHERE cc.contrat_id = ct.id) AS nb_classes
FROM public.enseignant ens
LEFT JOIN public.contrat_enseignant ct ON ct.enseignant_id = ens.id
LEFT JOIN public.anneeacademique aa    ON aa.id = ct.annee_academique_id
LEFT JOIN public.ecole ec              ON ec.id = ens.ecole_id
WHERE ens.site_id = assistant.site_courant()
  AND (assistant.ecole_courante() IS NULL
       OR ens.ecole_id IS NULL
       OR ens.ecole_id = assistant.ecole_courante());

COMMENT ON VIEW assistant.v_enseignants IS
  'Enseignants recrutés et leurs contrats. cout_previsionnel = taux_horaire x volume_horaire_global. '
  'Un enseignant sans contrat apparaît avec les colonnes de contrat à NULL.';

-- ---------------------------------------------------------------------------
--  6. Recrutement enseignant — agrégats seulement
--     Les candidats sont des personnes privées externes : ni nom, ni email,
--     ni téléphone. Seule la référence permet de retrouver le dossier dans l'ERP.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_candidatures AS
SELECT
  c.reference,
  c.grade,
  c.specialite,
  c.annees_experience,
  c.statut,                         -- recue | preselectionnee | transmise_rh | validee | refusee
  c.source,                         -- portail_public | saisie_interne
  c.created_at                      AS deposee_le,
  c.date_decision,
  o.reference                       AS offre_reference,
  o.titre                           AS offre_titre
FROM public.candidature_enseignant c
LEFT JOIN public.offre_emploi_enseignant o ON o.id = c.offre_id;

COMMENT ON VIEW assistant.v_candidatures IS
  'Candidatures enseignantes, sans identité du candidat (données personnelles externes). '
  'Utiliser reference pour retrouver le dossier complet dans l''espace RH.';

CREATE OR REPLACE VIEW assistant.v_offres_emploi AS
SELECT
  o.reference, o.titre, o.specialite, o.type_contrat,
  o.volume_horaire_indicatif, o.statut, o.date_publication, o.date_cloture,
  f.nom AS filiere, n.libelle AS niveau,
  (SELECT COUNT(*) FROM public.candidature_enseignant c WHERE c.offre_id = o.id) AS nb_candidatures
FROM public.offre_emploi_enseignant o
LEFT JOIN public.filiere f ON f.id = o.filiere_id
LEFT JOIN public.niveau n  ON n.id = o.niveau_id
WHERE o.site_id IS NULL OR o.site_id = assistant.site_courant();

COMMENT ON VIEW assistant.v_offres_emploi IS
  'Offres d''emploi enseignant publiées sur le site institutionnel.';

-- ---------------------------------------------------------------------------
--  7. Emploi du temps — séances datées et occupation des salles
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_seances AS
SELECT
  s.date_seance,
  s.heure_debut,
  s.heure_fin,
  ROUND(EXTRACT(EPOCH FROM (s.heure_fin - s.heure_debut)) / 3600.0, 2) AS duree_heures,
  s.type_seance,
  s.statut,
  cl.nom                            AS classe,
  m.nom                             AS matiere,
  sa.code                           AS salle_code,
  sa.nom                            AS salle,
  sa.capacite                       AS salle_capacite,
  ens.nom                           AS enseignant_nom,
  ens.prenoms                       AS enseignant_prenoms,
  f.nom                             AS filiere,
  n.libelle                         AS niveau,
  aa.annee                          AS annee_academique
FROM public.seance_edt s
JOIN public.classe cl               ON cl.id = s.classe_id
LEFT JOIN public.matiere m          ON m.id = s.matiere_id
LEFT JOIN public.salle sa           ON sa.id = s.salle_id
LEFT JOIN public.enseignant ens     ON ens.id = s.enseignant_id
LEFT JOIN public.filiere f          ON f.id = cl.filiere_id
LEFT JOIN public.departement d      ON d.id = f.departement_id
LEFT JOIN public.ecole ec           ON ec.id = d.ecole_id
LEFT JOIN public.niveau n           ON n.id = cl.niveau_id
LEFT JOIN public.anneeacademique aa ON aa.id = cl.annee_academique_id
WHERE (sa.site_id IS NULL OR sa.site_id = assistant.site_courant())
  AND (assistant.ecole_courante() IS NULL OR ec.id = assistant.ecole_courante());

COMMENT ON VIEW assistant.v_seances IS
  'Séances de cours planifiées. salle_code NULL = séance sans salle affectée. '
  'Pour le taux d''occupation d''une salle : SUM(duree_heures) GROUP BY salle_code.';

CREATE OR REPLACE VIEW assistant.v_salles AS
SELECT sa.code, sa.nom, sa.batiment, sa.etage, sa.capacite, sa.type_salle, sa.statut
FROM public.salle sa
WHERE sa.site_id = assistant.site_courant();

COMMENT ON VIEW assistant.v_salles IS 'Salles physiques du site.';

-- ---------------------------------------------------------------------------
--  8. Moyens généraux — stock et distribution des accessoires
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_stock AS
SELECT
  a.code,
  a.nom                             AS accessoire,
  a.seuil_alerte_defaut             AS seuil_alerte,
  a.cout_unitaire_reference,
  COALESCE(SUM(
    CASE WHEN mv.type IN ('reception', 'transfert_entrant', 'ajustement_inventaire') THEN mv.quantite
         WHEN mv.type IN ('distribution', 'transfert_sortant') THEN -mv.quantite
         ELSE 0 END
  ), 0)                             AS solde
FROM public.accessoire a
LEFT JOIN public.emplacement_stock es ON es.site_id = assistant.site_courant()
LEFT JOIN public.mouvement_stock mv   ON mv.accessoire_id = a.id
                                     AND mv.emplacement_stock_id = es.id
WHERE a.actif = true
GROUP BY a.id, a.code, a.nom, a.seuil_alerte_defaut, a.cout_unitaire_reference;

COMMENT ON VIEW assistant.v_stock IS
  'Solde de stock par accessoire pour le site. En alerte quand solde <= seuil_alerte.';

CREATE OR REPLACE VIEW assistant.v_distributions AS
SELECT
  dis.date_remise,
  dis.numero_recu,
  dis.ecole_nom                     AS ecole,
  dis.filiere_nom                   AS filiere,
  dis.niveau_nom                    AS niveau,
  dis.classe_nom                    AS classe,
  aa.annee                          AS annee_academique,
  a.nom                             AS accessoire,
  ld.quantite
FROM public.distribution dis
JOIN public.ligne_distribution ld    ON ld.distribution_id = dis.id
JOIN public.accessoire a             ON a.id = ld.accessoire_id
JOIN public.emplacement_stock es     ON es.id = dis.emplacement_stock_id
LEFT JOIN public.anneeacademique aa  ON aa.id = dis.annee_academique_id
WHERE es.site_id = assistant.site_courant()
  AND (assistant.ecole_courante() IS NULL
       OR dis.ecole_nom = (SELECT nom FROM public.ecole WHERE id = assistant.ecole_courante()));

COMMENT ON VIEW assistant.v_distributions IS
  'Remises d''accessoires aux étudiants, une ligne par article remis.';

-- ---------------------------------------------------------------------------
--  9. Référentiel — pour situer les questions dans le temps et la structure
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_annees_academiques AS
SELECT aa.id AS annee_academique_id, aa.annee, aas.etat, aas.date_ouverture, aas.date_fermeture
FROM public.anneeacademique aa
LEFT JOIN public.anneeacademique_site aas
       ON aas.anneeacademique_id = aa.id AND aas.site_id = assistant.site_courant();

COMMENT ON VIEW assistant.v_annees_academiques IS
  'Années académiques. etat = ''en cour'' pour l''année en cours sur ce site. '
  'TOUJOURS consulter cette vue pour traduire « l''année passée » ou « cette année » en annee_academique_id.';

CREATE OR REPLACE VIEW assistant.v_structure AS
SELECT ec.nom AS ecole, d.nom AS departement, f.nom AS filiere, f.sigle AS filiere_sigle,
       n.libelle AS niveau, n.ordre AS niveau_ordre, n.prix_formation
FROM public.filiere f
JOIN public.departement d ON d.id = f.departement_id
JOIN public.ecole ec      ON ec.id = d.ecole_id
LEFT JOIN public.niveau n ON n.filiere_id = f.id AND n.site_id = assistant.site_courant()
WHERE assistant.ecole_courante() IS NULL OR ec.id = assistant.ecole_courante();

COMMENT ON VIEW assistant.v_structure IS
  'Arborescence école > département > filière > niveau, avec le prix de formation.';

-- ---------------------------------------------------------------------------
--  10. Dictionnaire — le modèle découvre le schéma en interrogeant cette vue,
--      au lieu qu'on le fige dans le prompt (qui dériverait à chaque migration).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_dictionnaire AS
SELECT
  c.table_name                      AS vue,
  obj_description(('assistant.' || quote_ident(c.table_name))::regclass, 'pg_class') AS description,
  c.ordinal_position                AS position,
  c.column_name                     AS colonne,
  c.data_type                       AS type
FROM information_schema.columns c
WHERE c.table_schema = 'assistant' AND c.table_name <> 'v_dictionnaire'
ORDER BY c.table_name, c.ordinal_position;

COMMENT ON VIEW assistant.v_dictionnaire IS
  'Catalogue des vues disponibles et de leurs colonnes. Point de départ de toute exploration.';

-- ---------------------------------------------------------------------------
--  Privilèges — le rôle est créé par migrations/setup-role-assistant.js.
--  Ces GRANT sont rejoués à chaque exécution pour couvrir les vues ajoutées.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA assistant TO assistant_ro';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistant TO assistant_ro';
    EXECUTE 'GRANT EXECUTE ON FUNCTION assistant.site_courant() TO assistant_ro';
    EXECUTE 'GRANT EXECUTE ON FUNCTION assistant.ecole_courante() TO assistant_ro';
    -- Le rôle ne doit voir QUE ce schéma : pas d'accès aux tables brutes,
    -- donc pas de mot de passe ni de donnée personnelle atteignable.
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM assistant_ro';
    -- Les vues s'exécutent avec les privilèges de leur propriétaire
    -- (security_invoker désactivé par défaut) : assistant_ro lit les tables
    -- sous-jacentes à travers les vues sans avoir de droit direct dessus.
  END IF;
END $$;

COMMIT;

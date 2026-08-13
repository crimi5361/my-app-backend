-- ============================================================================
--  Assistant Fondateur — audit de l'activité des utilisateurs (2026-08-12)
--
--  Le fondateur veut un rapport d'activité par agent. Constat préalable, fait
--  sur la base réelle avant d'écrire cette migration :
--
--    historique_operations_admin ....... 0 ligne
--    historique_inscription ............ 0 ligne
--
--  Il n'existe donc AUCUN journal d'événements exploitable. En revanche quinze
--  colonnes « auteur » sont disséminées dans le schéma et, elles, sont bien
--  renseignées :
--
--    etudiant.inscrit_par ........... 7 208 lignes, 10 agents
--    paiement.effectue_par .......... 11 733 lignes,  8 agents
--    prise_en_charge.valide_par ......... 223 lignes,  2 agents
--    session_caisse.caissier_id ........... 5 lignes,  2 agents
--    mouvement_stock.effectue_par ......... 6 lignes,  1 agent
--
--  L'audit est donc reconstruit à partir de ces traces d'auteur, et non d'un
--  journal. C'est une limite réelle : on sait qui a CRÉÉ un enregistrement, pas
--  qui l'a consulté, modifié ou supprimé, ni qui s'est connecté. Les vues le
--  disent explicitement dans leur commentaire pour que le modèle ne présente
--  jamais ce rapport comme exhaustif.
--
--  EXCLUSION — l'administrateur de la plateforme (BOGA ANGE CHRISTIAN GUEMA)
--  est retiré de toutes les vues de cette migration. L'exclusion est faite DANS
--  les vues, pas dans le prompt : une consigne en langage naturel se contourne,
--  une clause WHERE non.
--
--  MOTS DE PASSE — utilisateur.mot_de_passe n'est exposé nulle part. La colonne
--  n'apparaît dans aucun SELECT ci-dessous, et assistant_ro n'a aucun droit sur
--  le schéma public : elle est inatteignable, hachée ou non.
--
--  TYPAGE — etudiant.inscrit_par et paiement.effectue_par sont des varchar
--  contenant des identifiants numeriques (heritage). Ils sont convertis ici avec
--  un garde-fou sur le motif : une valeur non numerique casserait la vue entiere.
--  Une valeur orpheline existe (etudiant.inscrit_par = '6142', aucun utilisateur
--  correspondant) ; la jointure l'ecarte naturellement.
--
--  Migration additive : aucun ALTER ni DROP sur une table existante.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  Agents exclus de l'audit
--
--  Table plutôt que constante en dur : l'exclusion doit pouvoir évoluer sans
--  redéployer de code, et elle reste visible/auditable en base.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assistant.agent_exclu (
  utilisateur_id int PRIMARY KEY REFERENCES utilisateur(id) ON DELETE CASCADE,
  motif          text NOT NULL,
  cree_le        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE assistant.agent_exclu IS
  'Agents retirés de toutes les vues d''audit. Le filtrage est fait dans les vues, pas dans le prompt.';

INSERT INTO assistant.agent_exclu (utilisateur_id, motif)
SELECT id, 'Administrateur de la plateforme — hors périmètre d''audit'
FROM utilisateur
WHERE upper(btrim(nom)) = 'BOGA ANGE CHRISTIAN GUEMA'
ON CONFLICT (utilisateur_id) DO NOTHING;

-- ---------------------------------------------------------------------------
--  14. Agents — l'annuaire, sans aucun secret
--
--  Exposé : identité professionnelle, rôle, statut, rattachement.
--  Jamais exposé : mot_de_passe (haché ou non), et rien d'autre de la table
--  utilisateur n'est sensible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_agents AS
SELECT
  u.id                              AS agent_id,
  u.nom                             AS agent,
  u.code                            AS matricule,
  r.nom                             AS role,
  r.description                     AS role_description,
  u.statut                          AS statut,
  s.nom                             AS site,
  ec.nom                            AS ecole
FROM utilisateur u
JOIN role r          ON r.id = u.role_id
JOIN site s          ON s.id = u.site_id
LEFT JOIN ecole ec   ON ec.id = u.ecole_id
WHERE u.site_id = assistant.site_courant()
  AND (assistant.ecole_courante() IS NULL OR u.ecole_id IS NULL OR u.ecole_id = assistant.ecole_courante())
  AND NOT EXISTS (SELECT 1 FROM assistant.agent_exclu x WHERE x.utilisateur_id = u.id);

COMMENT ON VIEW assistant.v_agents IS
  'Annuaire des agents du site (hors administrateur de la plateforme). Le mot de passe n''est pas exposé et ne peut pas l''être : le rôle assistant_ro n''a aucun droit sur le schéma public.';

-- ---------------------------------------------------------------------------
--  15. Journal d'activité reconstruit
--
--  Une ligne = un acte traçable, ramené à un vocabulaire commun (agent, date,
--  domaine, acte, volume). L'UNION ALL permet au modèle de compter, grouper et
--  comparer les agents sans connaître la disposition des tables sources.
--
--  `volume` porte le montant quand l'acte en a un (encaissement, prise en
--  charge), sinon NULL — SUM(volume) reste donc juste sur un filtre par domaine.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_activite_agents AS
WITH exclus AS (SELECT utilisateur_id FROM assistant.agent_exclu)
-- Inscriptions d'étudiants
SELECT
  e.inscrit_par::int                AS agent_id,
  e.date_inscription::timestamptz   AS horodatage,
  'Scolarité'::text                 AS domaine,
  'Inscription d''un étudiant'::text AS acte,
  NULL::numeric                     AS volume,
  e.matricule_iipea                 AS reference
FROM etudiant e
JOIN utilisateur u ON u.id::text = e.inscrit_par
WHERE e.inscrit_par ~ '^[0-9]+$'
  AND u.site_id = assistant.site_courant()
  AND u.id NOT IN (SELECT utilisateur_id FROM exclus)

UNION ALL

-- Encaissements de caisse
SELECT
  p.effectue_par::int,
  p.date_paiement::timestamptz,
  'Caisse'::text,
  'Encaissement'::text,
  p.montant::numeric,
  p.reference_transaction
FROM paiement p
JOIN utilisateur u ON u.id::text = p.effectue_par
WHERE p.effectue_par ~ '^[0-9]+$'
  AND u.site_id = assistant.site_courant()
  AND u.id NOT IN (SELECT utilisateur_id FROM exclus)

UNION ALL

-- Prises en charge validées
SELECT
  pc.valide_par,
  pc.date_validation::timestamptz,
  'Prise en charge'::text,
  'Validation d''une prise en charge'::text,
  pc.montant_reduction::numeric,
  pc.reference
FROM prise_en_charge pc
JOIN utilisateur u ON u.id = pc.valide_par
WHERE pc.valide_par IS NOT NULL
  AND u.site_id = assistant.site_courant()
  AND u.id NOT IN (SELECT utilisateur_id FROM exclus)

UNION ALL

-- Ouvertures de session de caisse
SELECT
  sc.caissier_id,
  sc.date_ouverture,
  'Caisse'::text,
  'Ouverture d''une session de caisse'::text,
  NULL::numeric,
  NULL::text
FROM session_caisse sc
JOIN utilisateur u ON u.id = sc.caissier_id
WHERE sc.caissier_id IS NOT NULL
  AND u.site_id = assistant.site_courant()
  AND u.id NOT IN (SELECT utilisateur_id FROM exclus)

UNION ALL

-- Mouvements de stock
SELECT
  ms.effectue_par,
  ms.date_mouvement::timestamptz,
  'Moyens généraux'::text,
  'Mouvement de stock'::text,
  ms.quantite::numeric,
  NULL::text
FROM mouvement_stock ms
JOIN utilisateur u ON u.id = ms.effectue_par
WHERE ms.effectue_par IS NOT NULL
  AND u.site_id = assistant.site_courant()
  AND u.id NOT IN (SELECT utilisateur_id FROM exclus);

COMMENT ON VIEW assistant.v_activite_agents IS
  'Journal d''activité RECONSTRUIT à partir des colonnes « auteur » des tables métier (inscrit_par, effectue_par, valide_par, caissier_id). LIMITE IMPORTANTE : on ne connaît que les CRÉATIONS. Aucune consultation, modification, suppression ni connexion n''est tracée dans cette base — les tables historique_operations_admin et historique_inscription sont vides. Ne jamais présenter ce journal comme exhaustif. Joindre v_agents sur agent_id pour obtenir le nom.';

-- ---------------------------------------------------------------------------
--  16. Synthèse par agent — le rapport prêt à lire
--
--  Évite au modèle de recomposer l'agrégat à chaque question, et garantit que
--  les agents sans aucune activité apparaissent quand même (LEFT JOIN) : un
--  compte actif qui ne fait rien est en soi une information d'audit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_synthese_agents AS
SELECT
  a.agent_id,
  a.agent,
  a.role,
  a.statut,
  a.ecole,
  count(j.agent_id)                                        AS actes_total,
  count(*) FILTER (WHERE j.domaine = 'Scolarité')          AS actes_scolarite,
  count(*) FILTER (WHERE j.domaine = 'Caisse')             AS actes_caisse,
  count(*) FILTER (WHERE j.domaine = 'Prise en charge')    AS actes_prise_en_charge,
  count(*) FILTER (WHERE j.domaine = 'Moyens généraux')    AS actes_moyens_generaux,
  COALESCE(sum(j.volume) FILTER (WHERE j.acte = 'Encaissement'), 0) AS montant_encaisse,
  COALESCE(sum(j.volume) FILTER (WHERE j.domaine = 'Prise en charge'), 0) AS montant_reductions_accordees,
  min(j.horodatage)                                        AS premier_acte,
  max(j.horodatage)                                        AS dernier_acte,
  count(*) FILTER (WHERE j.horodatage >= now() - interval '30 days') AS actes_30_jours
FROM assistant.v_agents a
LEFT JOIN assistant.v_activite_agents j ON j.agent_id = a.agent_id
GROUP BY a.agent_id, a.agent, a.role, a.statut, a.ecole;

COMMENT ON VIEW assistant.v_synthese_agents IS
  'Un agent par ligne, avec son volume d''activité par domaine. Les agents sans aucun acte apparaissent avec des compteurs à zéro : un compte actif et inactif est une information d''audit. Mêmes limites que v_activite_agents (créations uniquement).';

-- ---------------------------------------------------------------------------
--  Privilèges — rejoués pour couvrir les vues ajoutées par cette migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA assistant TO assistant_ro';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistant TO assistant_ro';
    -- agent_exclu est une TABLE : le SELECT ci-dessus la couvre, mais aucune
    -- écriture n'est accordée — le modèle ne peut pas se dé-restreindre.
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON assistant.agent_exclu FROM assistant_ro';
  END IF;
END $$;

COMMIT;

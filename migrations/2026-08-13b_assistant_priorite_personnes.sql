-- ============================================================================
--  Assistant Fondateur — retrouver le personnel parmi les etudiants (2026-08-13)
--
--  CONSTAT. Le fondateur ne parvenait plus a obtenir d'information sur un agent :
--  quel que soit le nom prononce, seuls des etudiants remontaient. Les agents
--  etaient pourtant bien dans l'annuaire, et bien trouvables. Mesure faite sur
--  la base reelle :
--
--    « nancy » ..... 12 resultats dont 1 agent  -> l'agent est visible
--    « manni » ......  2 resultats dont 1 agent  -> l'agent est visible
--    « kone » ...... 167 resultats dont 1 agent  -> AUCUN agent dans les 10 premiers
--
--  Il n'y a donc pas de defaut de recherche mais un defaut de RANG : 33 agents
--  contre 7 208 etudiants, et un tri alphabetique. Des que le nom est un peu
--  repandu, le LIMIT du modele ne ramene que des etudiants.
--
--  CORRECTIF. Une colonne de priorite, ajoutee en fin de vue, place le personnel
--  avant les etudiants. Le modele n'a plus qu'a trier dessus — c'est plus sur
--  que de lui demander de penser a filtrer, ce qu'il oublie des que la question
--  est formulee autrement.
--
--  BOGA ANGE CHRISTIAN GUEMA — l'administrateur de la plateforme etait exclu de
--  TOUTES les vues, y compris l'annuaire, ce qui le rendait introuvable. La
--  consigne d'origine portait sur les RAPPORTS D'ACTIVITE, pas sur l'annuaire :
--  l'exclusion est donc resserree sur les deux vues d'audit. Il redevient
--  identifiable par son nom, sans jamais figurer dans un rapport d'activite.
--
--  Migration additive : les colonnes sont AJOUTEES EN FIN de liste, seule forme
--  acceptee par CREATE OR REPLACE VIEW.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  Annuaire des agents — l'exclusion n'y a plus sa place
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
  AND (assistant.ecole_courante() IS NULL OR u.ecole_id IS NULL OR u.ecole_id = assistant.ecole_courante());

COMMENT ON VIEW assistant.v_agents IS
  'Annuaire des agents du site : identite professionnelle, role, statut, rattachement. Le mot de passe n''est pas expose et ne peut pas l''etre — le role assistant_ro n''a aucun droit sur le schema public. Tout le personnel y figure, y compris l''administrateur de la plateforme, qui reste en revanche exclu des vues d''audit.';

-- ---------------------------------------------------------------------------
--  Synthese d'activite — l'exclusion s'y applique desormais explicitement
--
--  Elle s'appuyait sur v_agents, qui portait le filtre. Maintenant que
--  l'annuaire est complet, la restriction doit etre posee ici, sinon
--  l'administrateur reapparaitrait dans les rapports avec des compteurs a zero.
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
WHERE a.agent_id NOT IN (SELECT utilisateur_id FROM assistant.agent_exclu)
GROUP BY a.agent_id, a.agent, a.role, a.statut, a.ecole;

COMMENT ON VIEW assistant.v_synthese_agents IS
  'Un agent par ligne, avec son volume d''activite par domaine. Les agents sans aucun acte apparaissent avec des compteurs a zero : un compte actif et inactif est une information d''audit. L''administrateur de la plateforme est exclu de cette vue. Memes limites que v_activite_agents (creations uniquement).';

-- ---------------------------------------------------------------------------
--  Annuaire unifie — avec un rang de priorite
--
--  `priorite` existe pour une raison mesurable : sans elle, un nom repandu
--  ramene 167 etudiants et le seul agent qui le porte n'apparait jamais dans
--  les premieres lignes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_personnes AS
SELECT
  'Étudiant'::text                                   AS categorie,
  e.nom_complet,
  assistant.normaliser(e.nom_complet)                AS nom_normalise,
  e.matricule                                        AS reference,
  e.filiere                                          AS rattachement,
  e.niveau                                           AS precision_1,
  e.annee_academique                                 AS precision_2,
  e.standing                                         AS etat,
  3                                                  AS priorite
FROM assistant.v_etudiants e

UNION ALL

SELECT
  'Agent'::text,
  a.agent,
  assistant.normaliser(a.agent),
  a.matricule,
  a.role,
  COALESCE(a.ecole, a.site),
  NULL::text,
  a.statut,
  1
FROM assistant.v_agents a

UNION ALL

SELECT
  'Enseignant'::text,
  btrim(COALESCE(t.nom, '') || ' ' || COALESCE(t.prenoms, '')),
  assistant.normaliser(COALESCE(t.nom, '') || ' ' || COALESCE(t.prenoms, '')),
  t.matricule,
  t.specialite,
  t.grade,
  t.annee_academique,
  t.statut_enseignant,
  2
FROM assistant.v_enseignants t;

COMMENT ON VIEW assistant.v_personnes IS
  'Annuaire unifie : etudiants, agents et enseignants dans une seule vue. POINT D''ENTREE OBLIGATOIRE pour retrouver quelqu''un a partir d''un fragment de nom. Ecrire : WHERE nom_normalise LIKE assistant.normaliser(''%Kone%'') — les pourcents a l''interieur de l''appel, sans operateur de concatenation. La base stocke « KONE » quand on dit « Kone », donc ni = ni ILIKE direct ne fonctionnent. TOUJOURS trier par priorite d''abord : le site compte 33 agents pour 7 208 etudiants, et sans ce tri un nom repandu ne ramene que des etudiants. Un etudiant apparait une fois par annee academique inscrite : compter avec COUNT(DISTINCT nom_complet).';

COMMENT ON COLUMN assistant.v_personnes.priorite IS
  'Rang d''affichage : 1 = agent, 2 = enseignant, 3 = etudiant. Mettre ORDER BY priorite en tete de tout classement de personnes.';
COMMENT ON COLUMN assistant.v_personnes.rattachement IS
  'Filiere pour un etudiant, role pour un agent, specialite pour un enseignant.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistant TO assistant_ro';
  END IF;
END $$;

COMMIT;

-- ============================================================================
--  Assistant Fondateur - verrouillage complet de l'administrateur (2026-08-19)
--
--  REVIREMENT ASSUME. Le 18 aout, le fondateur avait choisi de laisser
--  l'exclusion sur les seules vues d'audit, en connaissance de cause : l'etendre
--  aurait retire 19 007 actes des totaux generaux. Il demande aujourd'hui le
--  verrouillage total. Le present fichier remplace cette decision ; la note du
--  README est mise a jour en consequence.
--
--  PORTEE : l'administrateur disparait de l'ANNUAIRE, de la RECHERCHE et de la
--  TABLE DES COMPTES, en plus des deux vues d'audit ou il l'etait deja. Il ne
--  peut donc plus etre nomme, ni liste, ni exporte, ni agrege nominativement.
--
--  CE QUI SUBSISTE VOLONTAIREMENT : son identifiant reste present dans les
--  colonnes auteur (etudiant.inscrit_par, paiement.effectue_par). Le retirer
--  aurait fausse les totaux d'encaissement et d'inscription de l'etablissement,
--  ce qui aurait ete un mauvais echange - un chiffre de gestion faux pour
--  proteger une ligne. Cet identifiant ne porte aucune donnee personnelle, et
--  il ne peut plus etre resolu en nom puisque toutes les vues qui donnaient le
--  nom l'excluent.
--
--  Migration additive : remplacement de vues, aucune table touchee.
-- ============================================================================

BEGIN;

-- Annuaire des agents
CREATE OR REPLACE VIEW assistant.v_agents AS
SELECT u.id AS agent_id,
    u.nom AS agent,
    u.code AS matricule,
    r.nom AS role,
    r.description AS role_description,
    u.statut,
    s.nom AS site,
    ec.nom AS ecole
   FROM utilisateur u
     JOIN role r ON r.id = u.role_id
     JOIN site s ON s.id = u.site_id
     LEFT JOIN ecole ec ON ec.id = u.ecole_id
  WHERE NOT EXISTS (SELECT 1 FROM assistant.agent_exclu x WHERE x.utilisateur_id = u.id)
    AND (u.site_id = assistant.site_courant() AND (assistant.ecole_courante() IS NULL OR u.ecole_id IS NULL OR u.ecole_id = assistant.ecole_courante()));

COMMENT ON VIEW assistant.v_agents IS
  'Annuaire des agents du site. Le mot de passe n''est pas expose et ne peut pas l''etre. AUCUNE PHOTO n''existe pour le personnel. L''administrateur de la plateforme est retire de cette vue : ses donnees sont protegees et ne peuvent pas etre consultees.';

-- Comptes de connexion
CREATE OR REPLACE VIEW assistant.t_utilisateur AS
SELECT id,
    nom,
    email,
    site_id,
    role_id,
    statut,
    code,
    ecole_id
   FROM utilisateur
  WHERE NOT EXISTS (SELECT 1 FROM assistant.agent_exclu x WHERE x.utilisateur_id = id)
    AND (site_id = assistant.site_courant());

COMMENT ON VIEW assistant.t_utilisateur IS
  'Comptes de connexion du personnel. Mot de passe retire. L''administrateur de la plateforme est exclu : ses donnees sont protegees.';

COMMIT;

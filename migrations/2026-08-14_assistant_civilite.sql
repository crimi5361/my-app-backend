-- ============================================================================
--  Assistant Fondateur — civilité de l'accueil (2026-08-14)
--
--  L'assistante ouvre la conversation par « Bonjour Monsieur {nom} ». Le nom
--  vient de la session — jamais codé en dur — mais la civilité, elle, n'existe
--  nulle part : la table `utilisateur` porte id, nom, email, mot_de_passe,
--  site_id, role_id, statut, code et ecole_id. Aucun genre, aucune civilité.
--
--  Constat fait sur la base réelle avant d'écrire cette migration.
--
--  DEUX OPTIONS ÉCARTÉES, et pourquoi :
--
--    • « Monsieur » en dur dans le code — le jour où une femme occupe le poste,
--      il faut un déploiement pour la saluer correctement ;
--    • une colonne `civilite` sur la table `utilisateur` — c'est une table
--      métier de production, et nous nous sommes tenus à des migrations qui ne
--      touchent pas à l'existant.
--
--  La civilité est donc un RÉGLAGE du site, au même titre que le prénom de
--  l'assistante et la voix. Elle se change depuis l'écran des réglages, sans
--  redéploiement et sans migration.
--
--  Migration additive : ajout d'une colonne sur une table créée par
--  2026-08-13d_assistant_reglages.sql, avec valeur par défaut. Aucune donnée
--  existante n'est modifiée, aucune table métier n'est touchée.
-- ============================================================================

BEGIN;

ALTER TABLE assistant_reglages
  ADD COLUMN IF NOT EXISTS civilite varchar(12) NOT NULL DEFAULT 'Monsieur';

COMMENT ON COLUMN assistant_reglages.civilite IS
  'Civilité employée par l''assistante pour saluer l''utilisateur : Monsieur, Madame, ou vide pour une formule neutre. La table utilisateur ne porte aucun genre — c''est la raison d''être de ce réglage.';

COMMIT;

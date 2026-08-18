-- ============================================================================
--  Assistant Fondateur - derniere table exposee (2026-08-18)
--
--  Le fondateur a tranche : toute donnee personnelle est accessible a
--  l assistante, a l exception des MOTS DE PASSE. etudiant_email_backup avait
--  ete ecartee par prudence de ma part - elle contient des adresses de
--  courriel d etudiants. Cette prudence n avait pas lieu d etre : le fondateur
--  est responsable de ces donnees, et l assistante n est ouverte qu aux roles
--  admin et fondateur.
--
--  RESTENT HORS D ATTEINTE, definitivement :
--    etudiant.password
--    utilisateur.mot_de_passe
--    assistant_google_compte.jeton_rafraichissement
--
--  Les deux premiers sont des mots de passe. Le troisieme est le jeton qui
--  ouvre la boite Google du fondateur : un moyen d acces au meme titre qu un
--  mot de passe, et chiffre au repos - l exposer ne livrerait qu un bloc
--  illisible.
--
--  Migration additive.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW assistant.t_etudiant_email_backup AS
SELECT
  "id",
  "matricule_iipea",
  "email",
  "date_sauvegarde"
FROM etudiant_email_backup
WHERE matricule_iipea IN (SELECT matricule_iipea FROM etudiant WHERE site_id = assistant.site_courant());

COMMENT ON VIEW assistant.t_etudiant_email_backup IS
  'Sauvegarde ponctuelle des adresses de courriel d''etudiants (1058 lignes). Table figee, sans cle primaire : elle ne reflete pas l''etat courant, qui est dans etudiant.email. Cloisonnee par l''etudiant rattache.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'GRANT SELECT ON assistant.t_etudiant_email_backup TO assistant_ro';
  END IF;
END $$;

COMMIT;

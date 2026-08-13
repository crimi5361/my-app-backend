-- ============================================================================
--  Assistant Fondateur — réglages personnalisables (2026-08-13)
--
--  Le fondateur donne un prénom à son assistante, et choisit comment ouvrir le
--  mode vocal. Ces choix sont propres à un SITE, pas à un utilisateur : sur un
--  même site, tous les agents autorisés doivent voir la même assistante porter
--  le même nom, sinon la conversation devient incompréhensible d'un poste à
--  l'autre.
--
--  Table dans le schéma public, pas dans `assistant` : ce dernier est
--  intégralement lisible par le modèle, et il n'a aucune raison de pouvoir
--  interroger sa propre configuration en SQL — elle lui est déjà donnée dans
--  son instruction.
--
--  Migration additive : aucun ALTER ni DROP sur une table existante.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS assistant_reglages (
  site_id            int PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
  nom_assistant      varchar(40),
  -- 'bouton' | 'double_frappe' | 'mot_reveil'
  lancement_vocal    varchar(20) NOT NULL DEFAULT 'bouton',
  recherche_web      boolean NOT NULL DEFAULT false,
  maj_le             timestamptz NOT NULL DEFAULT now(),
  maj_par            int REFERENCES utilisateur(id)
);

COMMENT ON TABLE assistant_reglages IS
  'Personnalisation de l''Assistant Fondateur, par site. Une ligne par site, créée à la première modification.';
COMMENT ON COLUMN assistant_reglages.nom_assistant IS
  'Prénom donné par le fondateur. NULL = pas encore nommée ; elle se présente alors comme « votre assistante ».';
COMMENT ON COLUMN assistant_reglages.lancement_vocal IS
  'Comment ouvrir le mode vocal : bouton (défaut), double_frappe (deux appuis sur la barre d''espace), mot_reveil (prononcer son nom).';
COMMENT ON COLUMN assistant_reglages.recherche_web IS
  'Autorise l''assistante à consulter le web quand la réponse n''est pas dans la base. Désactivé par défaut : une recherche web sort du périmètre vérifiable de l''établissement.';

-- Le rôle de lecture du modèle n'a rien à faire ici : sa configuration lui est
-- fournie dans son instruction, il n'a pas à pouvoir l'interroger ni la deviner.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'REVOKE ALL ON assistant_reglages FROM assistant_ro';
  END IF;
END $$;

COMMIT;

-- ============================================================================
--  Assistant Fondateur — rattachement du compte Google (2026-08-12)
--
--  Un compte de service Google n'a ni boîte mail ni agenda, et la délégation à
--  l'échelle du domaine suppose Google Workspace (même impasse que celle déjà
--  documentée pour Drive dans services/documentStorage.service.js). L'assistant
--  agit donc avec le consentement OAuth du fondateur, dans SON agenda et SA
--  boîte, avec un accès révocable à tout moment sur myaccount.google.com.
--
--  Le jeton de rafraîchissement est un secret de longue durée : il est stocké
--  CHIFFRÉ (AES-256-GCM, clé dérivée de JWT_SECRET). Lire cette table ne suffit
--  donc pas à prendre la main sur la messagerie du fondateur.
--
--  La table vit dans le schéma public, pas dans `assistant` : celui-ci est
--  intégralement lisible par le rôle assistant_ro, donc par le modèle. Un jeton
--  d'accès à une boîte mail n'a rien à y faire.
--
--  Migration additive : aucun ALTER ni DROP sur une table existante.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS assistant_google_compte (
  utilisateur_id          int PRIMARY KEY REFERENCES utilisateur(id) ON DELETE CASCADE,
  site_id                 int NOT NULL REFERENCES site(id),
  email_google            varchar(255) NOT NULL,
  jeton_rafraichissement  text NOT NULL,
  portees                 text NOT NULL,
  cree_le                 timestamptz NOT NULL DEFAULT now(),
  maj_le                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE assistant_google_compte IS
  'Rattachement OAuth du compte Google d''un agent (agenda, Meet, Gmail). Une ligne par utilisateur.';
COMMENT ON COLUMN assistant_google_compte.jeton_rafraichissement IS
  'Chiffré AES-256-GCM au format iv:tag:données — voir services/assistantGoogle.service.js. Ne jamais exposer.';
COMMENT ON COLUMN assistant_google_compte.portees IS
  'Portées effectivement accordées par Google, séparées par des espaces. Sert à détecter un consentement partiel.';

-- Le rôle de l'assistant ne doit atteindre cette table sous aucune forme.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'REVOKE ALL ON assistant_google_compte FROM assistant_ro';
  END IF;
END $$;

COMMIT;

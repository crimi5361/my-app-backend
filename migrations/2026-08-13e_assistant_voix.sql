-- ============================================================================
--  Assistant Fondateur — choix de la voix (2026-08-13)
--
--  L'API Live expose une trentaine de voix préenregistrées, désignées par leur
--  nom. Google ne documente PAS leur genre : seulement un qualificatif de
--  timbre (« Warm », « Firm », « Soft »…). La sélection proposée au fondateur
--  est donc établie à l'écoute, et le service la borne — une valeur inconnue
--  retombe sur la voix par défaut plutôt que de faire échouer la session.
--
--  Migration additive : une colonne ajoutée à une table créée le même jour.
-- ============================================================================

BEGIN;

ALTER TABLE assistant_reglages
  ADD COLUMN IF NOT EXISTS voix varchar(30) NOT NULL DEFAULT 'Sulafat';

COMMENT ON COLUMN assistant_reglages.voix IS
  'Nom de la voix préenregistrée Gemini (voiceName). Défaut Sulafat, décrite « Warm » par Google. Validée côté service contre une liste fermée.';

COMMIT;

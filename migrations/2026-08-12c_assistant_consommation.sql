-- Assistant Fondateur — comptabilisation de la consommation (2026-08-12).
--
-- Le plafond de dépenses imposé par Google (250 $/mois au Niveau 1) n'est pas
-- réglable. On en pose donc un nôtre, dans l'application : chaque appel au modèle
-- déclare ses jetons, on convertit en FCFA et on refuse les requêtes au-delà du
-- budget fixé dans .env. L'arrêt se fait AVANT la dépense, pas après.
--
-- Migration additive : aucun ALTER ni DROP sur l'existant.

BEGIN;

CREATE TABLE IF NOT EXISTS assistant_consommation (
  id                   SERIAL PRIMARY KEY,
  site_id              INTEGER NOT NULL REFERENCES site(id),
  utilisateur_id       INTEGER REFERENCES utilisateur(id),
  canal                VARCHAR(10) NOT NULL CHECK (canal IN ('texte', 'vocal')),
  modele               VARCHAR(60) NOT NULL,

  -- Jetons texte et audio sont facturés à des tarifs différents : on les garde
  -- séparés pour que le coût reste recalculable si les tarifs changent.
  jetons_entree        INTEGER NOT NULL DEFAULT 0,
  jetons_sortie        INTEGER NOT NULL DEFAULT 0,
  jetons_audio_entree  INTEGER NOT NULL DEFAULT 0,
  jetons_audio_sortie  INTEGER NOT NULL DEFAULT 0,

  cout_usd             NUMERIC(12, 6) NOT NULL DEFAULT 0,
  cree_le              TIMESTAMP NOT NULL DEFAULT now()
);

-- La question posée à chaque appel est « combien ce site a-t-il dépensé ce mois-ci ? » :
-- l'index suit exactement cette lecture.
CREATE INDEX IF NOT EXISTS idx_conso_site_date ON assistant_consommation (site_id, cree_le DESC);

COMMENT ON TABLE assistant_consommation IS
  'Consommation de l''Assistant Fondateur, un enregistrement par appel au modèle. '
  'Sert au plafond mensuel applicatif et à l''affichage du budget consommé.';

COMMIT;

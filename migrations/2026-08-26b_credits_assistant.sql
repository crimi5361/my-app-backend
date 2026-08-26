-- ============================================================================
--  Assistant Fondateur - recharges de credits et seuil d'alerte (2026-08-26)
--
--  POURQUOI SAISIR CE QUE GOOGLE SAIT DEJA. Le solde de credits est tenu chez le
--  fournisseur, qui ne l'expose par aucune API exploitable ici. L'ancien plafond
--  applicatif s'en est deja fait piéger : il coupait l'assistante sur un montant
--  imaginaire pendant que la vraie limite etait ailleurs. Plutot que de deviner,
--  l'administrateur DECLARE ce qu'il a recharge, et le solde se deduit de cette
--  declaration moins la consommation reellement mesuree.
--
--  LE SOLDE EST DONC UNE ESTIMATION, ET L'ECRAN DOIT LE DIRE. Il repose sur la
--  table de tarifs de assistantBudget.service.js, relevee le 2026-08-12 et non
--  revérifiee depuis. Si un tarif change, le solde derive sans que rien ne le
--  signale. C'est un ordre de grandeur pour decider quand recharger, jamais un
--  releve de compte.
--
--  POURQUOI DEUX TABLES ET NON UNE COLONNE DE PLUS SUR assistant_reglages. Cette
--  table-la porte la persona de l'assistante - son prenom, sa voix, sa civilite,
--  reglages du FONDATEUR. Les credits sont une affaire d'ADMINISTRATION, que le
--  fondateur n'a pas a voir. Melanger les deux mettrait un montant en dollars
--  dans le meme enregistrement qu'un prenom, et exposerait l'un en exposant
--  l'autre.
--
--  Migration ADDITIVE : deux tables nouvelles, aucun objet existant touche.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS assistant_recharge (
  id             BIGSERIAL PRIMARY KEY,
  site_id        INTEGER        NOT NULL,
  -- En DOLLARS, l'unite dans laquelle le fournisseur facture. La conversion en
  -- francs se fait a l'affichage : stocker des francs figerait un taux de change
  -- dans l'historique et rendrait tout recalcul impossible.
  montant_usd    NUMERIC(12, 4) NOT NULL CHECK (montant_usd > 0),
  -- Date de la recharge chez le fournisseur, qui n'est pas forcement celle de la
  -- saisie : l'administrateur peut regulariser plusieurs jours apres.
  date_recharge  DATE           NOT NULL DEFAULT CURRENT_DATE,
  saisi_par      INTEGER,
  note           TEXT,
  cree_le        TIMESTAMPTZ    NOT NULL DEFAULT now()
);

COMMENT ON TABLE assistant_recharge IS
  'Recharges de credits declarees par l''administrateur. Le solde de l''assistante '
  'en est deduit : total recharge moins consommation mesuree DEPUIS LA PREMIERE '
  'recharge. Compter depuis l''origine du projet melangerait la periode gratuite, '
  'ou rien n''etait facture, avec la periode payante.';

CREATE INDEX IF NOT EXISTS idx_assistant_recharge_site
  ON assistant_recharge (site_id, date_recharge DESC);

-- Un seul reglage aujourd'hui, mais une table plutot qu'une colonne : le seuil
-- appellera d'autres reglages d'administration (destinataire de l'alerte, pas de
-- recharge conseille), et les ajouter ici ne demandera pas d'ALTER.
CREATE TABLE IF NOT EXISTS assistant_alerte (
  site_id           INTEGER      PRIMARY KEY,
  -- En POURCENTAGE du total recharge. Un seuil en dollars serait a refaire a
  -- chaque changement de rythme ; un pourcentage suit le montant recharge.
  seuil_pourcentage INTEGER      NOT NULL DEFAULT 80
                    CHECK (seuil_pourcentage BETWEEN 1 AND 100),
  maj_le            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  maj_par           INTEGER
);

COMMENT ON TABLE assistant_alerte IS
  'Seuil au-dela duquel la console previent l''administrateur, en pourcentage du '
  'total recharge. L''alerte s''affiche dans la console d''administration et JAMAIS '
  'dans l''assistante : le fondateur n''a pas a connaitre ces questions-la.';

COMMIT;

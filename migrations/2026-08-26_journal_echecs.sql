-- ============================================================================
--  Assistant Fondateur - journal des echecs (2026-08-26)
--
--  POURQUOI CETTE TABLE EXISTE. Jusqu'ici, rien de ce que l'assistante vit
--  n'etait conserve : le chat vivait dans le localStorage du navigateur, le
--  vocal dans la memoire de la page. Fermer l'onglet effacait tout. Quand elle
--  repondait « il n'y a aucun enseignant » alors que la base en comptait 115,
--  ce defaut n'a ete decouvert qu'en le reproduisant a la main, des semaines
--  plus tard. Cette table est ce qui rend un tel defaut VISIBLE le jour meme.
--
--  ON N'ENREGISTRE QUE LES ECHECS - decision du 2026-08-26, prise en connaissance
--  de cause. Un enregistrement complet des conversations aurait permis de relire
--  une reponse contestee et d'analyser ce qui marche ; il aurait aussi conserve
--  des donnees nominatives sur des personnes reelles, sans necessite. On garde
--  donc uniquement ce qui casse, et pendant DIX JOURS.
--
--  LA PURGE N'EST PAS ICI. Neon n'expose pas pg_cron sur ce palier : la retention
--  est appliquee par le service applicatif, qui supprime les lignes echues au fil
--  des ecritures (voir services/assistantJournal.service.js). Ce commentaire le
--  dit pour que personne ne cherche un declencheur inexistant.
--
--  Migration ADDITIVE : une table nouvelle, un index, aucun objet existant
--  modifie ni supprime.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS assistant_echec (
  id              BIGSERIAL PRIMARY KEY,
  site_id         INTEGER      NOT NULL,
  utilisateur_id  INTEGER,
  -- 'texte' ou 'vocal'. Volontairement sans contrainte d'enumeration : un canal
  -- nouveau ne doit jamais faire echouer une ecriture de journal.
  canal           TEXT         NOT NULL,
  genre           TEXT         NOT NULL,
  outil           TEXT,
  -- La question telle qu'elle a ete posee. A l'ecrit, le texte saisi ; a la voix,
  -- la derniere transcription du fondateur. Peut etre NULL : a la voix, un outil
  -- declenche avant toute parole n'a pas de question a rattacher.
  question        TEXT,
  detail          TEXT,
  -- Le SELECT reellement execute, quand l'echec vient d'une requete. C'est ce qui
  -- permet de comprendre POURQUOI zero ligne est revenu, au lieu de le constater.
  sql_execute     TEXT,
  cree_le         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE assistant_echec IS
  'Journal des echecs de l''assistante, conserve 10 jours. Ecrit uniquement quand '
  'un outil echoue, ne trouve rien, hesite entre plusieurs personnes, ou quand '
  'l''assistante declare une impasse. Les reponses reussies ne sont pas conservees.';

COMMENT ON COLUMN assistant_echec.genre IS
  'panne : l''outil a leve une erreur ou la base n''a pas repondu. '
  'vide : la requete etait valide et n''a ramene aucune ligne - le cas le plus '
  'precieux, c''est celui des 115 enseignants introuvables. '
  'introuvable : aucune personne ne porte ce nom. '
  'ambigu : plusieurs homonymes, l''assistante a du redemander. '
  'impasse : l''assistante a elle-meme declare ne pas pouvoir repondre. '
  'repli : le modele de tete etait epuise, un modele de secours a pris le relais.';

-- Le journal se lit TOUJOURS par site et du plus recent au plus ancien - c'est
-- la seule lecture que fait la console. La purge, elle, balaye sur cree_le seul,
-- et cet index la sert aussi puisque la table reste petite par construction.
CREATE INDEX IF NOT EXISTS idx_assistant_echec_site_date
  ON assistant_echec (site_id, cree_le DESC);

COMMIT;

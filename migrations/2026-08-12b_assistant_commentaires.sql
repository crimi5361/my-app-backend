-- Assistant Fondateur — précision des descriptions de vues (2026-08-12).
--
-- Constat en test : à la question « montre-moi l'encaissement par école », le modèle
-- a répondu 80 000 FCFA (table `paiement`, 2 lignes) alors que le cumul réellement
-- versé par les étudiants est de 1,67 milliard (`scolarite_verse`). Un écart de
-- ~20 000x, et les deux lectures sont défendables : la table `paiement` ne contient
-- que les encaissements passés par le module Caisse, pas l'historique repris.
--
-- Le modèle ne peut pas deviner cette particularité : on la lui dit. Ces descriptions
-- sont injectées dans son contexte via assistant.v_dictionnaire.
--
-- Migration additive : uniquement des COMMENT ON.

BEGIN;

COMMENT ON VIEW assistant.v_etudiants IS
  'Étudiants du site, avec leur position financière. Une ligne par étudiant et par année. '
  'standing = ''Inscrit'' pour les inscriptions effectives. '
  'ATTENTION — c''est la SOURCE DE RÉFÉRENCE pour tout ce qui touche à la scolarité et au '
  'chiffre d''affaires : montant_scolarite = dû total, scolarite_verse = cumul réellement '
  'payé par l''étudiant (toutes origines confondues, y compris l''historique repris), '
  'scolarite_restante = reste à recouvrer. '
  'Pour « chiffre d''affaires », « recettes », « encaissé », « ce qu''on a reçu » : utilise '
  'SUM(scolarite_verse) ICI, et non v_paiements qui ne couvre qu''une partie.';

COMMENT ON VIEW assistant.v_paiements IS
  'Journal des encaissements passés par le module Caisse, une ligne par transaction. '
  'ATTENTION — cette vue ne contient PAS tout l''historique des règlements : les montants '
  'repris à la mise en service n''y figurent pas. Son total est très inférieur au cumul de '
  'v_etudiants.scolarite_verse, et ce n''est pas une anomalie. '
  'À utiliser UNIQUEMENT pour des questions sur l''activité de caisse : encaissements du jour, '
  'du mois, par caissier, par mode de paiement, évolution des transactions. '
  'Pour un chiffre d''affaires ou un total encaissé, utilise v_etudiants.scolarite_verse.';

COMMIT;

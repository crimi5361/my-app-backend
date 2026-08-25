-- Découvrabilité : mettre l'avertissement en PREMIÈRE phrase — 2026-08-25
--
-- LE DÉFAUT. Le catalogue injecté dans l'instruction système donne les vues
-- métier `v_*` en entier, mais des reflets `t_*` il ne garde que la PREMIÈRE
-- PHRASE, tronquée à 170 caractères (assistantSql.service.js, premierePhrase).
-- Toute mise en garde placée en deuxième phrase n'atteint donc jamais le modèle.
--
-- Cas mesuré le 2026-08-25. Le commentaire de t_professeur disait, en deuxième
-- phrase : « NE PAS CONFONDRE avec la table enseignant (module RH plus récent,
-- vide localement) ». Coupé. Interrogée sur ses enseignants, l'assistante lisait
-- v_enseignants — dont la première phrase, « Enseignants recrutés et leurs
-- contrats. », ne laisse rien soupçonner — obtenait zéro ligne, et concluait
-- qu'il n'y a pas d'enseignants. Il y en a 115, exposés, à un nom de vue près.
--
-- Ce n'est ni un défaut de couverture (les 74 tables sont atteintes), ni un
-- défaut de droits (93 objets en SELECT), ni un défaut de fraîcheur (aucune vue
-- matérialisée). C'est un défaut de DÉCOUVRABILITÉ, et il se corrige dans le
-- texte : ce qui compte doit être dit en premier.
--
-- Même traitement pour les cinq autres vues vides et pour v_paiements, dont
-- l'avertissement — le module Caisse n'a servi que deux fois sur 11 733
-- paiements — était noyé en deuxième phrase alors qu'il expose à un contresens
-- immédiat sur les encaissements.
--
-- Migration purement additive : uniquement des COMMENT ON. Aucune structure,
-- aucune donnée, aucun privilège n'est touché. Rejouable sans effet de bord.

-- ── Enseignants : la table en service, et celle qui ne l'est pas ────────────

COMMENT ON VIEW assistant.t_professeur IS
'LES ENSEIGNANTS DE L''ETABLISSEMENT, table EN SERVICE et peuplee : c''est ICI '
'qu''il faut chercher un enseignant, un professeur, un formateur ou un '
'intervenant, et NON dans v_enseignants ni t_enseignant, qui sont vides. '
'Colonnes : nom, prenom, statut, date_creation. '
'Ce qu''un enseignant enseigne se lit dans t_enseignement (professeur_id, '
'matiere_id, groupe_id) ; les notes s''y rattachent par enseignement_id. '
'— NON cloisonnee : referentiel partage entre les sites.';

COMMENT ON VIEW assistant.t_enseignant IS
'VIDE — n''utilise pas cette table : pour les enseignants, va dans t_professeur, '
'qui est la table en service. Celle-ci appartient au module RH (recrutement, '
'contrats), introduit en aout 2026 et pas encore alimente sur ce site. '
'Confirme par COUNT(*) si tu veux le verifier. — Cloisonnee par site_id.';

-- ── Les six vues metier sans donnee ────────────────────────────────────────

COMMENT ON VIEW assistant.v_enseignants IS
'VIDE — le module Enseignants (recrutement et contrats) n''est pas alimente sur '
'ce site : cette vue rend zero ligne, et cela ne signifie PAS qu''il n''y a pas '
'd''enseignants. Pour les enseignants reellement en service, utilise '
'assistant.t_professeur. '
'Si le module etait alimente : cout_previsionnel = taux_horaire x '
'volume_horaire_global, et un enseignant sans contrat apparait avec les colonnes '
'de contrat a NULL.';

COMMENT ON VIEW assistant.v_salles IS
'VIDE — aucune salle n''est enregistree sur ce site : la planification des '
'locaux n''est pas utilisee ici. Ne conclus pas que l''etablissement n''a pas de '
'salles ; conclus que la donnee n''est pas saisie dans cette base, et dis-le '
'ainsi au fondateur.';

COMMENT ON VIEW assistant.v_seances IS
'VIDE — aucune seance de cours n''est planifiee dans cette base : le module '
'emploi du temps structure n''est pas utilise ici. t_emploi_du_temps ne contient '
'que des FICHIERS deposes par groupe (chemin, nom, date), pas des creneaux '
'exploitables : tu peux les compter, tu ne peux pas dire qui enseigne quoi a '
'quelle heure. Dis-le franchement plutot que de chercher ailleurs.';

COMMENT ON VIEW assistant.v_candidatures IS
'VIDE — aucune candidature enseignante n''est enregistree : le module '
'recrutement n''est pas utilise sur ce site. Si des candidatures existaient, '
'elles seraient sans identite du candidat (donnees personnelles externes) et '
'reference servirait a retrouver le dossier dans l''espace RH.';

COMMENT ON VIEW assistant.v_offres_emploi IS
'VIDE — aucune offre d''emploi enseignant n''est publiee : le module '
'recrutement n''est pas utilise sur ce site.';

COMMENT ON VIEW assistant.v_distributions IS
'VIDE — aucune remise d''accessoire n''est tracee ligne a ligne. Pour ce qui est '
'attribue aux etudiants, utilise t_kit ; pour le catalogue des articles, '
't_accessoire ; pour les entrees et sorties, t_mouvement_stock.';

-- ── Caisse : l'avertissement passe en tete ─────────────────────────────────

COMMENT ON VIEW assistant.v_paiements IS
'PRESQUE VIDE, ET CE N''EST PAS UNE ANOMALIE — n''utilise JAMAIS cette vue pour '
'un total encaisse ni pour un chiffre d''affaires : elle exige un rattachement a '
'une caisse, que la quasi-totalite des reglements n''a pas, et son total est donc '
'sans commune mesure avec la realite. '
'Pour un total encaisse : v_etudiants.scolarite_verse. '
'Pour le detail transaction par transaction : t_paiement. '
'Cette vue ne sert QU''aux questions portant sur l''activite du module Caisse '
'lui-meme : encaissements par caissier, par mode de paiement, sessions de caisse.';

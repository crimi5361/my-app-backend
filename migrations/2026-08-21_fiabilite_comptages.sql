-- Fiabilité des comptages — 2026-08-21
--
-- POURQUOI. Interrogée sur l'effectif, l'assistante répondait « 7 208 lignes,
-- soit 6 620 étudiants uniques », en prenant le matricule pour une clé
-- d'identité. C'est faux : 556 étudiants sur 7 208 (7,7 %) portent un matricule
-- inexploitable — 99 vides et 457 composés uniquement de zéros (« 00000 »,
-- « 0000000000 »…). Compter les matricules distincts SOUS-ESTIME donc l'effectif
-- de plusieurs centaines, avec l'aplomb d'un chiffre précis.
--
-- La règle juste est plus simple : v_etudiants porte UNE ligne par étudiant et
-- par année, donc COUNT(*) EST l'effectif. Encore faut-il que l'assistante le
-- sache — elle ne lit que ces commentaires.
--
-- Migration purement additive : uniquement des COMMENT ON. Aucune structure,
-- aucune donnée, aucun privilège n'est touché. Rejouable sans effet de bord.

COMMENT ON VIEW assistant.v_etudiants IS
'Etudiants du site, avec leur position financiere. UNE LIGNE PAR ETUDIANT ET PAR ANNEE : '
'l''effectif se compte donc avec COUNT(*), jamais avec COUNT(DISTINCT matricule). '
'standing = ''Inscrit'' pour les effectifs. '
'PIEGE MESURE LE 2026-08-21 : le matricule n''est PAS une cle unique et ne doit servir '
'a aucun comptage — 556 etudiants sur 7 208 en portent un inexploitable (99 vides, '
'457 uniquement des zeros), et 23 valeurs sont partagees par plusieurs etudiants. '
'Compter les matricules distincts sous-estime l''effectif de plusieurs centaines. '
'a_photo indique si une photo est disponible pour cet etudiant : 2 742 sur 7 208 en ont '
'une, mesure le 2026-08-19. Pour montrer une fiche avec photo, filtrer WHERE a_photo.';

COMMENT ON COLUMN assistant.v_etudiants.matricule IS
'Matricule administratif. NE PAS UTILISER COMME IDENTIFIANT NI POUR DEDOUBLONNER : '
'99 sont vides, 457 ne contiennent que des zeros, et 23 valeurs sont partagees par '
'plusieurs etudiants (mesure le 2026-08-21). Sert a afficher ou a rechercher une '
'personne, jamais a compter.';

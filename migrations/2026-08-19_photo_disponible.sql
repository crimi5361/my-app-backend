-- ============================================================================
--  Assistant Fondateur - savoir qui a une photo (2026-08-19)
--
--  Le fondateur a demande a l'assistante de lui montrer une fiche AVEC photo.
--  Elle n'a pas pu : rien dans les vues ne disait si une photo existe. Elle a
--  fini par repondre qu'elle n'avait pas cette information, ce qui etait vrai
--  mais evitable - la donnee est la, elle n'etait simplement pas exposee.
--
--  `a_photo` est ajoutee en FIN de liste : CREATE OR REPLACE VIEW n'autorise
--  que l'ajout en queue, jamais l'insertion ni le renommage.
--
--  CHIFFRES MESURES CE JOUR : 2 742 etudiants sur 7 208 ont une photo, soit
--  39 %. Le PERSONNEL n'en a aucune - la table utilisateur ne porte aucune
--  colonne d'image. Les deux commentaires le disent, pour que l'assistante
--  cesse de chercher ce qui n'existe pas.
--
--  Migration additive.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW assistant.v_etudiants AS
SELECT e.matricule,
    aa.annee AS annee_academique,
    e.annee_academique_id,
    ec.nom AS ecole,
    f.nom AS filiere,
    f.sigle AS filiere_sigle,
    n.libelle AS niveau,
    cu.type_parcours AS cursus,
    e.sexe,
    e.nationalite,
    e.standing,
    e.statut_scolaire,
    e.statut_paiement,
    e.source_inscription,
    e.date_inscription,
    e.montant_scolarite,
    e.scolarite_verse,
    e.scolarite_restante,
    e.nom,
    e.prenoms,
    btrim((COALESCE(e.nom, ''::character varying)::text || ' '::text) || COALESCE(e.prenoms, ''::character varying)::text) AS nom_complet,
    (e.photo_url IS NOT NULL AND btrim(e.photo_url) <> '') AS a_photo
   FROM vue_position_academique e
     LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
     LEFT JOIN filiere f ON f.id = e.id_filiere
     LEFT JOIN departement d ON d.id = f.departement_id
     LEFT JOIN ecole ec ON ec.id = d.ecole_id
     LEFT JOIN niveau n ON n.id = e.niveau_id
     LEFT JOIN curcus cu ON cu.id = e.curcus_id
  WHERE e.site_id = assistant.site_courant() AND (assistant.ecole_courante() IS NULL OR ec.id = assistant.ecole_courante());

COMMENT ON VIEW assistant.v_etudiants IS
  'Etudiants du site, avec leur position financiere. Une ligne par etudiant et par annee. standing = ''Inscrit'' pour les effectifs. a_photo indique si une photo est disponible pour cet etudiant : 2 742 sur 7 208 en ont une, mesure le 2026-08-19. Pour montrer une fiche avec photo, filtrer WHERE a_photo.';

COMMENT ON VIEW assistant.v_agents IS
  'Annuaire des agents du site : identite professionnelle, role, statut, rattachement. Le mot de passe n''est pas expose et ne peut pas l''etre. AUCUNE PHOTO n''existe pour le personnel : la table utilisateur ne porte aucune colonne d''image. Ne jamais promettre la photo d''un agent.';

COMMIT;

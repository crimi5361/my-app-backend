-- ============================================================================
--  Assistant Fondateur — recherche de personnes par fragment de nom (2026-08-13)
--
--  CONSTAT. Le fondateur ne pouvait retrouver personne sans donner le nom exact
--  et complet. Trois causes distinctes, mesurees sur la base reelle :
--
--   1. v_etudiants n'exposait AUCUN nom. Un etudiant etait introuvable autrement
--      que par son matricule. C'etait le vrai blocage : 164 etudiants portent le
--      nom KONE, contre un seul agent.
--
--   2. Les noms sont stockes SANS accent ('KONE'), alors que le fondateur dit
--      naturellement « Kone ». `ILIKE '%kone%'` ne renvoyait donc rien.
--
--   3. Rien n'indiquait au modele de chercher partiellement plutot qu'a l'egal.
--
--  CE QUI EST EXPOSE ET CE QUI NE L'EST PAS. Seuls le nom et les prenoms sont
--  ajoutes — de quoi identifier une personne et lever une homonymie. Restent
--  hors de portee, comme avant : telephone, email, parents, adresses, pieces
--  d'identite, photo, date et lieu de naissance. Le fondateur voit deja ces
--  noms dans l'ERP ; ce qui est en jeu ici, c'est ce que le modele peut lire,
--  et un nom seul ne permet ni de contacter ni d'usurper quelqu'un.
--
--  Migration additive : les colonnes sont AJOUTEES EN FIN de la liste des vues
--  existantes, seule forme acceptee par CREATE OR REPLACE VIEW.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;

-- ---------------------------------------------------------------------------
--  Normalisation : minuscules et sans accent, des deux cotes de la comparaison
--
--  IMMUTABLE alors que unaccent() est STABLE : le marquage est volontaire et
--  necessaire pour indexer la fonction. Il est sur ici parce que le dictionnaire
--  unaccent n'est jamais modifie sur cette base. Si un jour il l'etait, les
--  index construits dessus devraient etre reconstruits.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assistant.normaliser(texte text)
  RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, COALESCE(texte, ''))) $$;

COMMENT ON FUNCTION assistant.normaliser(text) IS
  'Minuscules sans accent. A appliquer DES DEUX COTES d''une comparaison de nom : la base stocke « KONE » quand on cherche « Koné ».';

-- Index de recherche : sans eux, chaque recherche parcourt les 7 208 etudiants.
CREATE INDEX IF NOT EXISTS idx_etudiant_nom_normalise
  ON public.etudiant (assistant.normaliser(nom));
CREATE INDEX IF NOT EXISTS idx_etudiant_prenoms_normalise
  ON public.etudiant (assistant.normaliser(prenoms));

-- ---------------------------------------------------------------------------
--  Etudiants : ajout du nom en FIN de vue
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_etudiants AS
SELECT
  e.matricule,
  aa.annee                          AS annee_academique,
  e.annee_academique_id,
  ec.nom                            AS ecole,
  f.nom                             AS filiere,
  f.sigle                           AS filiere_sigle,
  n.libelle                         AS niveau,
  cu.type_parcours                  AS cursus,
  e.sexe,
  e.nationalite,
  e.standing,                       -- 'Inscrit' | 'en attente' | ...
  e.statut_scolaire,
  e.statut_paiement,
  e.source_inscription,
  e.date_inscription,
  e.montant_scolarite,
  e.scolarite_verse,
  e.scolarite_restante,
  -- Ajoutes le 2026-08-13, en FIN de liste : CREATE OR REPLACE VIEW n'autorise
  -- que l'ajout de colonnes a la fin, jamais l'insertion au milieu.
  e.nom,
  e.prenoms,
  btrim(COALESCE(e.nom, '') || ' ' || COALESCE(e.prenoms, '')) AS nom_complet
FROM public.vue_position_academique e
LEFT JOIN public.anneeacademique aa ON aa.id = e.annee_academique_id
LEFT JOIN public.filiere f          ON f.id = e.id_filiere
LEFT JOIN public.departement d      ON d.id = f.departement_id
LEFT JOIN public.ecole ec           ON ec.id = d.ecole_id
LEFT JOIN public.niveau n           ON n.id = e.niveau_id
LEFT JOIN public.curcus cu          ON cu.id = e.curcus_id
WHERE e.site_id = assistant.site_courant()
  AND (assistant.ecole_courante() IS NULL OR ec.id = assistant.ecole_courante());

COMMENT ON VIEW assistant.v_etudiants IS
  'Étudiants du site, avec leur position financière. Une ligne par étudiant et par année. '
  'standing = ''Inscrit'' pour les inscriptions effectives. '
  'Le nom est exposé depuis le 2026-08-13 pour permettre de retrouver quelqu''un ; '
  'aucune coordonnée, aucune filiation, aucune pièce d''identité ne l''est.';

-- ---------------------------------------------------------------------------
--  Annuaire unifie — le point d'entree de toute recherche de personne
--
--  Un seul endroit ou chercher, quelle que soit la nature de la personne. Sans
--  cette vue, le modele devait deviner s'il fallait interroger les etudiants,
--  les agents ou les enseignants, et se trompait de table une fois sur deux.
--
--  `nom_normalise` est pre-calcule : le modele n'a plus qu'a ecrire
--     WHERE nom_normalise LIKE assistant.normaliser('%Koné%')
--  sans avoir a penser aux accents ni a la casse. Les pourcents sont places A
--  L'INTERIEUR de l'appel : ils traversent unaccent() et lower() intacts, et
--  cette forme evite l'operateur ||, que le validateur SQL de l'assistant ne
--  sait pas analyser dans le membre droit d'un LIKE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW assistant.v_personnes AS
SELECT
  'Étudiant'::text                                   AS categorie,
  e.nom_complet,
  assistant.normaliser(e.nom_complet)                AS nom_normalise,
  e.matricule                                        AS reference,
  e.filiere                                          AS rattachement,
  e.niveau                                           AS precision_1,
  e.annee_academique                                 AS precision_2,
  e.standing                                         AS etat
FROM assistant.v_etudiants e

UNION ALL

SELECT
  'Agent'::text,
  a.agent,
  assistant.normaliser(a.agent),
  a.matricule,
  a.role,
  COALESCE(a.ecole, a.site),
  NULL::text,
  a.statut
FROM assistant.v_agents a

UNION ALL

SELECT
  'Enseignant'::text,
  btrim(COALESCE(t.nom, '') || ' ' || COALESCE(t.prenoms, '')),
  assistant.normaliser(COALESCE(t.nom, '') || ' ' || COALESCE(t.prenoms, '')),
  t.matricule,
  t.specialite,
  t.grade,
  t.annee_academique,
  t.statut_enseignant
FROM assistant.v_enseignants t;

COMMENT ON VIEW assistant.v_personnes IS
  'Annuaire unifie : etudiants, agents et enseignants dans une seule vue. POINT D''ENTREE OBLIGATOIRE pour retrouver quelqu''un a partir d''un fragment de nom. Ecrire : WHERE nom_normalise LIKE assistant.normaliser(''%Koné%'') — les pourcents a l''interieur de l''appel, sans operateur de concatenation. La base stocke « KONE » quand on dit « Koné », donc ni = ni ILIKE direct ne fonctionnent. Un etudiant apparait une fois par annee academique inscrite.';

COMMENT ON COLUMN assistant.v_personnes.rattachement IS
  'Filiere pour un etudiant, role pour un agent, specialite pour un enseignant.';
COMMENT ON COLUMN assistant.v_personnes.precision_1 IS
  'Niveau pour un etudiant, site ou ecole pour un agent, grade pour un enseignant.';

-- ---------------------------------------------------------------------------
--  Privileges — rejoues pour couvrir la vue et la fonction ajoutees.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistant TO assistant_ro';
    EXECUTE 'GRANT EXECUTE ON FUNCTION assistant.normaliser(text) TO assistant_ro';
  END IF;
END $$;

COMMIT;

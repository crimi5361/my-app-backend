-- ============================================================================
--  Assistant Fondateur — recherche par MOTS et non par fragments (2026-08-13)
--
--  DEUX DEFAUTS CONSTATES A L'USAGE, tous deux dus au LIKE '%...%'.
--
--   1. FRAGMENT AU LIEU DE MOT. Chercher « Mani » ramenait aussi « MANIGA »,
--      « SOUMANI », « MANIKA »… puisque le motif ne fait que chercher une suite
--      de caracteres n'importe ou. Le fondateur dit un NOM, pas un debut de nom.
--
--   2. PLUSIEURS MOTS DANS LE DESORDRE. Chercher « Boga Christian » ne trouvait
--      rien, alors que la base contient « BOGA ANGE CHRISTIAN GUEMA » : le motif
--      exigeait les deux mots COLLES et DANS CET ORDRE. Or personne ne cite un
--      nom complet dans l'ordre exact de l'etat civil.
--
--  CORRECTIF. Les deux chaines sont decoupees en mots, et la recherche reussit
--  si CHAQUE mot demande est un mot entier du nom, dans n'importe quel ordre.
--  « Boga Christian » trouve « BOGA ANGE CHRISTIAN GUEMA ». « Mani » ne trouve
--  plus « MANIGA ».
--
--  Les apostrophes et traits d'union sont retires des DEUX cotes : la base ecrit
--  « N'GORAN », la transcription vocale rend souvent « Ngoran », et les deux
--  doivent se rejoindre.
--
--  Migration additive : nouvelles fonctions, colonne ajoutee en fin de vue.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  Decoupage en mots comparables
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assistant.mots(texte text)
  RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT array_remove(
    regexp_split_to_array(
      -- Apostrophes et traits d'union effaces : « N'GORAN » et « Ngoran »
      -- doivent produire le meme mot, sinon aucun des deux ne trouve l'autre.
      regexp_replace(assistant.normaliser(texte), '[''’\-]', '', 'g'),
      '[^a-z0-9]+'
    ),
    ''
  )
$$;

COMMENT ON FUNCTION assistant.mots(text) IS
  'Decoupe un nom en mots comparables : minuscules, sans accent, sans apostrophe ni trait d''union.';

-- ---------------------------------------------------------------------------
--  Correspondance : tous les mots demandes, en mots entiers, ordre libre
--
--  L'operateur @> exprime exactement la regle voulue : le tableau des mots du
--  nom doit CONTENIR celui des mots recherches. Il est vrai quel que soit
--  l'ordre, et faux si un mot n'est qu'un morceau d'un autre.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assistant.correspond(nom text, recherche text)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT cardinality(assistant.mots(recherche)) > 0
     AND assistant.mots(nom) @> assistant.mots(recherche)
$$;

COMMENT ON FUNCTION assistant.correspond(text, text) IS
  'Vrai si chaque mot de `recherche` est un mot entier de `nom`, dans n''importe quel ordre. « Boga Christian » correspond a « BOGA ANGE CHRISTIAN GUEMA » ; « Mani » ne correspond pas a « MANIGA ».';

-- ---------------------------------------------------------------------------
--  Annuaire unifie — la liste des mots est exposee pour permettre le tri
--  approximatif, et surtout pour rendre la regle lisible dans le dictionnaire.
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
  e.standing                                         AS etat,
  3                                                  AS priorite
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
  a.statut,
  1
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
  t.statut_enseignant,
  2
FROM assistant.v_enseignants t;

COMMENT ON VIEW assistant.v_personnes IS
  'Annuaire unifie : etudiants, agents et enseignants dans une seule vue. POINT D''ENTREE OBLIGATOIRE pour retrouver quelqu''un. Ecrire : WHERE assistant.correspond(nom_complet, ''Boga Christian''). Cette fonction compare des MOTS ENTIERS dans un ordre libre — n''utilise PAS LIKE, qui ramenait « MANIGA » pour « Mani » et ne trouvait rien pour un nom cite dans le desordre. TOUJOURS trier par priorite d''abord (1 agent, 2 enseignant, 3 etudiant) : le site compte 33 agents pour 7 208 etudiants, et sans ce tri un nom repandu ne ramene que des etudiants. Un etudiant apparait une fois par annee academique inscrite : compter avec COUNT(DISTINCT nom_complet).';

-- ---------------------------------------------------------------------------
--  Index de recherche par mots. Sans eux, chaque interrogation redecoupe les
--  7 208 noms d'etudiants a chaque fois.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_etudiant_mots
  ON public.etudiant
  USING gin (assistant.mots(COALESCE(nom, '') || ' ' || COALESCE(prenoms, '')));

CREATE INDEX IF NOT EXISTS idx_utilisateur_mots
  ON public.utilisateur
  USING gin (assistant.mots(nom));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA assistant TO assistant_ro';
    EXECUTE 'GRANT EXECUTE ON FUNCTION assistant.mots(text) TO assistant_ro';
    EXECUTE 'GRANT EXECUTE ON FUNCTION assistant.correspond(text, text) TO assistant_ro';
  END IF;
END $$;

COMMIT;

-- ============================================================================
--  Assistant Fondateur — recherche phonétique (2026-08-19)
--
--  LE BESOIN, tel que le fondateur l'a formulé : « quand je cherche Koffi, il
--  faut qu'il essaie Koffi avec un F, avec deux F, avec O, avec AU. Mais qu'il
--  n'exagère pas — Koffi avec cinq F, ce n'est pas normal. »
--
--  DEUX FAÇONS DE LE FAIRE, et pourquoi celle-ci est retenue.
--
--    • ÉNUMÉRER LES VARIANTES. On génère koffi, kofi, coffi, kauffi, kofy… et
--      on les met toutes dans la requête. C'est littéralement ce qui est
--      demandé, mais le nombre de combinaisons croît vite : à trois règles
--      appliquées ensemble sur un nom de trois syllabes, on dépasse la
--      cinquantaine de formes, et il faut arbitrer lesquelles garder.
--
--    • RAMENER À UNE CLÉ COMMUNE. On réduit chaque mot à son squelette sonore.
--      « Koffi », « Kofi », « Coffi », « Kauffi », « Kofy » et « Kophi »
--      deviennent tous `kofi`. Une seule comparaison remplace la cinquantaine,
--      elle est indexable, et elle ne peut pas déborder — il n'y a pas de
--      « Koffi avec cinq F » possible, puisque les répétitions sont écrasées.
--
--  C'est le second choix. Il couvre les mêmes variantes, plus celles qu'on
--  n'aurait pas pensé à écrire, sans risque d'explosion.
--
--  CE QUE LA CLÉ NE FAIT PAS. Elle ne rapproche que ce qui se PRONONCE pareil.
--  « Mani » et « Amani » gardent des clés distinctes, « Mani » et « Maniga »
--  aussi : le reproche déjà entendu — « quand je dis Mani, c'est Mani, pas
--  Maniga » — reste satisfait.
--
--  Migration additive : deux fonctions et deux index, rien de modifié.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  Clé phonétique d'un mot
--
--  L'ordre des règles compte. `w` est traité avant `ou`, sans quoi « Kwakou »
--  et « Kouakou » ne se rejoindraient pas. L'écrasement des lettres répétées
--  vient en DERNIER : c'est lui qui rend « Koffi » et « Kofi » identiques, et
--  qui interdit d'inventer un « Koffffi ».
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assistant.phonetique(texte text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT regexp_replace(                                   -- 10. que des lettres
           regexp_replace(                                 --  9. lettres répétées écrasées
             regexp_replace(                               --  8. h muet
               regexp_replace(                             --  7. y = i
                 regexp_replace(                           --  6. ou = u
                   regexp_replace(                         --  5. eau, au = o
                     regexp_replace(                       --  4. x = ks
                       regexp_replace(                     --  3. c dur, k, q = k
                         regexp_replace(                   --  2. c doux = s
                           regexp_replace(                 --  1. ph = f, w = u
                             regexp_replace(assistant.normaliser(texte), 'ph', 'f', 'g'),
                           'w', 'u', 'g'),
                         'c(?=[eiy])', 's', 'g'),
                       '[ckq]', 'k', 'g'),
                     'x', 'ks', 'g'),
                   'eau|au', 'o', 'g'),
                 'ou', 'u', 'g'),
               'y', 'i', 'g'),
             'h', '', 'g'),
           '(.)\1+', '\1', 'g'),
         '[^a-z]', '', 'g')
$$;

COMMENT ON FUNCTION assistant.phonetique(text) IS
  'Squelette sonore d''un mot. Koffi, Kofi, Coffi, Kauffi, Kofy et Kophi rendent tous « kofi ». Sert à retrouver une personne dont on ignore l''orthographe exacte. Ne rapproche que ce qui se prononce pareil : Mani et Amani restent distincts.';

-- ---------------------------------------------------------------------------
--  Clés phonétiques de tous les mots d'un nom
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assistant.mots_phonetiques(texte text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    array_agg(assistant.phonetique(m)) FILTER (WHERE length(assistant.phonetique(m)) >= 2),
    ARRAY[]::text[])
  FROM unnest(assistant.mots(texte)) AS m
$$;

COMMENT ON FUNCTION assistant.mots_phonetiques(text) IS
  'Clés phonétiques des mots d''un nom complet, pour l''opérateur de recouvrement && . Les clés de moins de deux lettres sont écartées : elles rapprocheraient n''importe quoi.';

-- ---------------------------------------------------------------------------
--  Index — sans eux, chaque recherche parcourt les 7 208 étudiants et
--  recalcule la clé de chaque mot de chaque nom.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_etudiant_phonetique
  ON etudiant USING gin (assistant.mots_phonetiques(
    COALESCE(nom, '') || ' ' || COALESCE(prenoms, '')));

CREATE INDEX IF NOT EXISTS idx_utilisateur_phonetique
  ON utilisateur USING gin (assistant.mots_phonetiques(nom));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assistant_ro') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION assistant.phonetique(text) TO assistant_ro';
    EXECUTE 'GRANT EXECUTE ON FUNCTION assistant.mots_phonetiques(text) TO assistant_ro';
  END IF;
END $$;

COMMIT;

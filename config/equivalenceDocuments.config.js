// Configuration centralisée des pièces justificatives du module Équivalence — source unique
// utilisée à la fois par GET /documents-requis (affichage portail public) et par
// POST /deposer (revalidation serveur, jamais confiance au seul frontend). Un seul endroit à
// modifier pour toute évolution des règles — voir document de conception §5.1.
//
// Clé = libellé de niveau normalisé (MAJUSCULES, sans espace) — même convention que les
// regex de cycle déjà utilisées dans reinscription.controller.js / FormationCascadeSelect.tsx.
//
// Deux formes d'entrée :
//   - { code, obligatoire }                          : document simple
//   - { groupe, obligatoire, options: [code, code] }  : au moins un des `options` requis si
//                                                        `obligatoire` est vrai (facultatif sinon)

// Mêmes réglages obligatoire/facultatif que les documents standards d'admission
// (type_document, contexte='admission') : CMU facultatif, le reste obligatoire.
const DOCUMENTS_STANDARDS = [
  { code: 'EQ_DIPLOME_BAC', obligatoire: true },
  { code: 'EQ_EXTRAIT_NAISSANCE', obligatoire: true },
  { code: 'EQ_PIECE_IDENTITE', obligatoire: true },
  { code: 'EQ_CMU', obligatoire: false },
];

const documentsParNiveau = {
  BTS2: [
    { code: 'EQ_BULLETINS_BTS1', obligatoire: true },
  ],
  LICENCE2: [
    { code: 'EQ_BULLETINS_L1', obligatoire: true },
  ],
  LICENCE2PRO: [
    { code: 'EQ_BULLETINS_L1PRO', obligatoire: true },
  ],
  LICENCE3: [
    { code: 'EQ_BULLETINS_L1', obligatoire: true },
    { code: 'EQ_BULLETINS_L2', obligatoire: true },
  ],
  LICENCE3PRO: [
    { groupe: 'BULLETINS_ANTERIEURS', obligatoire: false, options: ['EQ_BULLETINS_BTS2', 'EQ_BULLETINS_L2PRO'] },
    { groupe: 'PREUVE_DIPLOME', obligatoire: true, options: ['EQ_DIPLOME_BTS', 'EQ_ATTESTATION_ADMISSIBILITE'] },
  ],
  MASTER2: [
    { code: 'EQ_BULLETINS_M1', obligatoire: true },
    { code: 'EQ_DIPLOME_L3', obligatoire: true },
  ],
  // Aligné sur MASTER2 (pièces non précisées séparément côté métier — document de conception §10).
  MASTER2PRO: [
    { code: 'EQ_BULLETINS_M1', obligatoire: true },
    { code: 'EQ_DIPLOME_L3', obligatoire: true },
  ],
};

// Même mécanique de filtrage que l'admission (FormationCascadeSelect), inversée : un niveau
// est éligible à l'équivalence si son libellé n'est PAS une 1ère année de cycle.
const NIVEAU_PREMIERE_ANNEE_REGEX = /^(BTS|LICENCE|MASTER)\s*1(\s*PRO)?$/i;

const estNiveauEligibleEquivalence = (niveauLibelle) => {
  const lib = String(niveauLibelle || '').trim();
  return lib.length > 0 && !NIVEAU_PREMIERE_ANNEE_REGEX.test(lib);
};

// "LICENCE 2 PRO" -> "LICENCE2PRO", "BTS 2" -> "BTS2"
const normaliserCleNiveau = (niveauLibelle) =>
  String(niveauLibelle || '').trim().toUpperCase().replace(/\s+/g, '');

// Résout, pour un niveau donné, la liste complète des documents requis (standards + spécifiques
// au niveau), sous une forme aplatie exploitable directement par l'UI et par la validation
// serveur : chaque entrée simple devient { code, obligatoire, groupe: null } et chaque groupe
// alternatif devient une entrée { groupe, obligatoire, options: [{code}, ...] }.
const resoudreDocumentsRequis = (niveauLibelle) => {
  const cle = normaliserCleNiveau(niveauLibelle);
  const specifiques = documentsParNiveau[cle] || [];
  const standards = DOCUMENTS_STANDARDS.map((d) => ({ code: d.code, obligatoire: d.obligatoire, groupe: null }));
  const specifiquesNormalises = specifiques.map((entree) =>
    entree.groupe
      ? { groupe: entree.groupe, obligatoire: entree.obligatoire, options: entree.options }
      : { code: entree.code, obligatoire: entree.obligatoire, groupe: null }
  );
  return [...standards, ...specifiquesNormalises];
};

// Vérifie qu'un ensemble de codes de documents fournis (Set<string>) satisfait toutes les
// exigences obligatoires résolues pour ce niveau. Retourne la liste des manques (libellés
// humains) — vide si tout est en règle. Utilisée par POST /deposer (revalidation serveur).
const validerDocumentsFournis = (niveauLibelle, codesFournis) => {
  const requis = resoudreDocumentsRequis(niveauLibelle);
  const manques = [];
  for (const entree of requis) {
    if (!entree.obligatoire) continue;
    if (entree.groupe) {
      const satisfait = entree.options.some((code) => codesFournis.has(code));
      if (!satisfait) manques.push(`${entree.groupe} (au moins un parmi : ${entree.options.join(', ')})`);
    } else if (!codesFournis.has(entree.code)) {
      manques.push(entree.code);
    }
  }
  return manques;
};

module.exports = {
  DOCUMENTS_STANDARDS,
  documentsParNiveau,
  estNiveauEligibleEquivalence,
  normaliserCleNiveau,
  resoudreDocumentsRequis,
  validerDocumentsFournis,
};

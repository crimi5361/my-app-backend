// Vocabulaire métier de l'IIPEA — source unique (2026-08-14).
//
// POURQUOI UN SEUL FICHIER. Ces termes servaient à trois endroits : le biais
// dicté à la reconnaissance vocale du mode vocal, la correction du texte dicté
// dans le chat écrit, et la casse des sigles. Éparpillés, ils divergeaient — un
// terme ajouté pour l'oral ne corrigeait pas l'écrit. Tout part désormais d'ici.
//
// CE QUI EST DANS CE FICHIER : ce qui ne se déduit d'aucune donnée. Les noms des
// agents, des écoles et des filières, eux, viennent de la base — ils changent au
// rythme des recrutements et n'ont rien à faire dans du code (voir
// services/assistantVocabulaire.service.js, qui fusionne les deux).

// ───────────────────────────────────────────────────────────────────────────
//  Termes dictés à la reconnaissance vocale
// ───────────────────────────────────────────────────────────────────────────

/**
 * Termes métier fixes, indépendants du site.
 *
 * Ce sont ceux que le fondateur emploie chaque jour et qu'un modèle acoustique
 * générique rend mal, faute de les avoir jamais rencontrés. Les intitulés de
 * rôles sont ceux de la table `role`, pas des approximations.
 */
const TERMES_METIER = [
  // Établissement et lieux
  'IIPEA', 'Abidjan', 'Cocody', "Côte d'Ivoire", 'franc CFA', 'francs CFA',

  // Scolarité
  'filière', 'filières', 'scolarité', 'matricule', 'réinscription',
  'inscription', 'effectif', 'effectifs', 'promotion', 'redoublant',
  'licence', 'master', 'BTS', 'semestre', 'maquette', 'unité d\'enseignement',
  'année académique', 'emploi du temps', 'relevé de notes', 'procès-verbal',

  // Finance
  'caisse', 'encaissement', 'recouvrement', 'échéancier', 'prise en charge',
  'tarif', 'reliquat', 'versement', 'session de caisse',

  // Rôles réels de la plateforme (table `role`)
  'fondateur', 'administrateur', 'scolarité', 'comptabilité', 'caissier',
  'archiviste', 'moyens généraux', 'chargé pédagogique', 'ressources humaines',
  'enseignant',

  // Pilotage
  'audit', 'tableau de bord', 'chiffre d\'affaires', 'trésorerie',
];

// ───────────────────────────────────────────────────────────────────────────
//  Casse des sigles
// ───────────────────────────────────────────────────────────────────────────

/**
 * Sigles à rétablir en capitales.
 *
 * La reconnaissance vocale rend « BTS » en « bts » ou « Bts » selon l'humeur du
 * décodage. La clé est la forme normalisée (minuscules, sans accent), la valeur
 * est la seule graphie correcte.
 *
 * Uniquement des sigles SANS homonyme courant en français : « ue » n'y figure
 * pas, parce qu'il apparaîtrait au milieu de mots légitimes.
 */
const SIGLES = {
  iipea: 'IIPEA',
  bts: 'BTS',
  lmd: 'LMD',
  ects: 'ECTS',
  edt: 'EDT',
  cfa: 'CFA',
  rh: 'RH',
  pdf: 'PDF',
  crm: 'CRM',
  erp: 'ERP',
};

// ───────────────────────────────────────────────────────────────────────────
//  Confusions récurrentes
// ───────────────────────────────────────────────────────────────────────────

/**
 * Corrections de phrases entières mal reconnues.
 *
 * PRUDENCE VOLONTAIRE : cette liste ne contient que des suites de mots qui n'ont
 * aucun sens en français hors du malentendu qu'elles corrigent. Une correction
 * trop large abîmerait des phrases correctes, et le fondateur n'aurait aucun
 * moyen de comprendre pourquoi ses mots changent.
 *
 * La clé est normalisée (minuscules, sans accent). Elle est comparée sur des
 * mots entiers.
 */
const CORRECTIONS = [
  // Observé en production : « Comment puis-je vous aider » devenait
  // « Commentaire puis-je vous athlète ».
  { de: 'commentaire puis-je', vers: 'comment puis-je' },
  { de: 'vous athlete', vers: 'vous aider' },
  // Épellations rendues phonétiquement.
  { de: 'i i p e a', vers: 'IIPEA' },
  { de: 'be te esse', vers: 'BTS' },
  { de: 'franc sefa', vers: 'francs CFA' },
  { de: 'francs sefa', vers: 'francs CFA' },
  { de: 'seh fa', vers: 'CFA' },
];

/** Mots qui ouvrent une question — servent à choisir le point final. */
const OUVERTURES_QUESTION = [
  'combien', 'comment', 'pourquoi', 'quand', 'ou', 'qui', 'quoi',
  'quel', 'quelle', 'quels', 'quelles', 'est-ce', 'peux-tu', 'peut-on',
  'y a-t-il', 'as-tu', 'sais-tu',
];

module.exports = { TERMES_METIER, SIGLES, CORRECTIONS, OUVERTURES_QUESTION };

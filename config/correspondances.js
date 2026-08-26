// Sujets vides dont le nom recouvre un sujet peuplé (2026-08-26).
//
// LE DÉFAUT QUE CETTE LISTE REND VISIBLE. L'assistante répondait « il n'y a
// aucun enseignant » alors que la base en comptait 115. Elle n'avait pas de
// problème de DROITS : les 115 lignes lui étaient parfaitement lisibles. Elle
// avait un problème de NOM — elle cherchait « enseignants », tombait sur un
// sujet vide portant exactement ce nom, et concluait.
//
// C'est pourquoi le bon détecteur n'est pas « une donnée présente que
// l'assistante ne voit pas » : mesuré ainsi, le compteur affiche zéro. Le bon
// détecteur est « un sujet VIDE dont le nom recouvre un sujet PEUPLÉ ».
//
// DEUX SOURCES, ET IL EN FAUT DEUX. Certains cas se détectent tout seuls, quand
// le commentaire du sujet vide nomme lui-même l'endroit où la donnée vit — c'est
// le cas de `t_enseignant`, dont le commentaire a été réécrit le 25 août pour
// cela. Les autres ne se devinent pas : rien dans `t_seance_edt` ne dit que les
// emplois du temps sont ailleurs. Ceux-là sont déclarés ici, à la main, et
// viennent du même travail que la table de correspondance de l'instruction
// système. Les deux listes doivent rester d'accord.
//
// CE FICHIER N'EST PAS UNE VÉRITÉ FIGÉE. Un sujet aujourd'hui vide peut se
// remplir : le jour où le module RH est alimenté, `t_enseignant` cesse d'être un
// écart et devient une donnée. Le détecteur le constate à chaque ouverture — il
// ne se fie jamais à cette liste pour savoir si un sujet est vide, seulement
// pour savoir où regarder ensuite.

/**
 * @typedef {Object} Correspondance
 * @property {string} vide     sujet consulté qui ne rend rien
 * @property {string} peuple   sujet où la donnée se trouve réellement
 * @property {string} mots     ce que le fondateur dit pour désigner ce sujet
 */

/** @type {Correspondance[]} */
const CORRESPONDANCES = [
  {
    vide: 't_enseignant',
    peuple: 't_professeur',
    mots: 'enseignant, professeur, prof, formateur, intervenant, corps enseignant',
  },
  {
    vide: 't_seance_edt',
    peuple: 't_emploi_du_temps',
    mots: 'emploi du temps, planning, horaires, séance de cours, créneau',
  },
  {
    vide: 't_distribution',
    peuple: 't_kit',
    mots: 'fournitures, kit, accessoires, dotation, remise, distribution',
  },
  {
    vide: 't_resultat',
    peuple: 't_note',
    mots: 'bulletin, note, évaluation, moyenne, résultat',
  },
];

/** Indexé par sujet vide, pour une recherche directe. */
const PAR_VIDE = new Map(CORRESPONDANCES.map((c) => [c.vide, c]));

module.exports = { CORRESPONDANCES, PAR_VIDE };

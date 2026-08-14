// Reconnaissance d'un accord ou d'un refus (2026-08-14).
//
// L'assistante propose un débriefing ; le fondateur répond en parlant, donc
// rarement par « oui » ou « non » secs. Il dit « vas-y », « je t'écoute »,
// « pas maintenant », « une autre fois ».
//
// POURQUOI CE MODULE ET PAS LE MODÈLE. Trois raisons :
//   • le résultat est déterministe — la même phrase donne toujours la même
//     décision, et on peut le prouver par des tests ;
//   • il ne consomme aucun jeton alors qu'il s'exécute à chaque ouverture ;
//   • une mauvaise interprétation ne coûte pas une requête inutile mais un
//     rapport entier lu à voix haute, ou pire, l'inverse : un fondateur qui a
//     dit oui et n'obtient rien.
//
// PLUS LONGUE EXPRESSION GAGNE. C'est le cœur de l'algorithme, et il résout à
// lui seul les pièges du français :
//   « pourquoi pas »       -> accord    (et non refus sur « pas »)
//   « oui mais pas maintenant » -> refus (« pas maintenant » l'emporte sur « oui »)
//   « je ne veux pas »     -> refus     (et non accord sur « je veux »)
//
// Aucune dépendance : ce module se teste seul.

/** Marques d'accord, telles qu'on les prononce réellement. */
const ACCORDS = [
  'oui', 'ouais', 'oui merci', 'oui vas-y', 'ouep', 'yes',
  'vas-y', 'vas y', 'allez-y', 'allez y', 'allons-y', 'allons y',
  "je t'ecoute", 'je vous ecoute', 'je t ecoute',
  "d'accord", 'd accord', 'daccord', 'ok', 'okay', 'okey',
  'bien sur', 'volontiers', 'avec plaisir', 'je veux bien', 'je veux',
  'carrement', 'pourquoi pas', 'ca m interesse', "ca m'interesse",
  'fais-le', 'fais le', 'fais donc', 'presente-le', 'presente le',
  'montre-moi', 'montre moi', 'dis-moi', 'dis moi', 'raconte',
  'parfait', 'tres bien', 'entendu', 'evidemment', 'absolument',
  's il te plait', "s'il te plait", 'je suis preneur', 'ca marche',
];

/** Marques de refus. Aucune n'est un simple « pas » : il fallait la phrase
 *  entière, sans quoi « pourquoi pas » aurait été lu comme un refus. */
const REFUS = [
  'non', 'non merci', 'nan', 'surtout pas',
  'pas maintenant', 'pas tout de suite', 'pas la peine', 'pas besoin',
  'pas aujourd hui', "pas aujourd'hui", 'pas envie',
  'plus tard', 'une autre fois', 'un autre moment', 'laisse tomber',
  'laisse', 'oublie', 'oublie ca', 'ce n est pas la peine',
  "ce n'est pas la peine", 'sans facon', 'je ne veux pas', 'je ne peux pas',
  'je n ai pas le temps', "je n'ai pas le temps", 'plus tard merci',
  'negatif', 'annule', 'stop',
];

/** Minuscules, sans accent, sans ponctuation : la forme sur laquelle on compare. */
function normaliser(texte) {
  return String(texte || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // L'apostrophe typographique est celle que produisent la reconnaissance
    // vocale et les claviers modernes. Sans cette ligne, « ça m'intéresse »
    // écrit avec ’ ne correspondait à rien.
    .replace(/[’‘`´]/g, "'")
    .replace(/[.,;:!?«»"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * L'expression apparaît-elle dans le texte, sur des mots entiers ?
 *
 * `\b` ne suffit pas quand l'expression finit par un tiret (« vas-y ») ni
 * lorsqu'elle contient une apostrophe : on borne donc explicitement par un
 * début de chaîne ou un caractère non alphanumérique.
 */
function contient(texteNormalise, expression) {
  const motif = new RegExp(`(^|[^a-z0-9])${echapper(expression)}($|[^a-z0-9])`);
  return motif.test(texteNormalise);
}

/** Longueur de la plus longue expression d'une liste présente dans le texte. */
function meilleureCorrespondance(texteNormalise, expressions) {
  let meilleure = 0;
  for (const expression of expressions) {
    if (expression.length > meilleure && contient(texteNormalise, expression)) {
      meilleure = expression.length;
    }
  }
  return meilleure;
}

/**
 * Lit un accord, un refus, ou reconnaît qu'on ne peut pas trancher.
 *
 * L'ambiguïté est un RÉSULTAT, pas un échec : mieux vaut redemander une fois que
 * lire un rapport entier à quelqu'un qui a dit « hmm ».
 *
 * @param {string} texte  ce que le fondateur a répondu
 * @returns {'oui'|'non'|'ambigu'}
 */
function intentionOuiNon(texte) {
  const n = normaliser(texte);
  if (!n) return 'ambigu';

  const accord = meilleureCorrespondance(n, ACCORDS);
  const refus = meilleureCorrespondance(n, REFUS);

  if (accord === 0 && refus === 0) return 'ambigu';
  // Égalité stricte entre deux expressions de même longueur : on ne devine pas.
  if (accord === refus) return 'ambigu';
  return accord > refus ? 'oui' : 'non';
}

module.exports = { intentionOuiNon, normaliser, ACCORDS, REFUS };

// Texte de l'accueil (2026-08-14).
//
// La phrase exacte et la mise en forme du nom, SANS aucune dépendance : ni base,
// ni réglages. Deux raisons de les isoler ici :
//
//   • elles se testent alors seules, sans qu'un test ouvre une connexion à la
//     base de production pour vérifier une majuscule ;
//   • la phrase est un texte imposé, mot pour mot. Le mettre dans un fichier qui
//     ne fait que ça le rend facile à retrouver et à relire.

/**
 * Met un nom en forme pour être lu et prononcé.
 *
 * Les noms sont saisis en capitales dans cette base — « KONE ISMAEL »,
 * « N'GORAN ESTHER AKISSI ». Lus tels quels par une synthèse vocale ils passent,
 * mais affichés tels quels ils crient.
 *
 * On ne retouche QUE les noms entièrement en capitales : « Christopher Tape »
 * est déjà correct, et l'abaisser puis le recapitaliser ne ferait que risquer de
 * le dégrader.
 */
function formaterNom(brut) {
  const nom = String(brut || '').replace(/\s+/g, ' ').trim();
  if (!nom) return '';
  // Une seule minuscule suffit à prouver que le nom est déjà mis en forme.
  if (/\p{Ll}/u.test(nom)) return nom;

  // Capitale après un espace, un tiret ou une apostrophe : « N'Goran » et
  // « Marie-Claire » gardent leur seconde majuscule.
  return nom.toLowerCase().replace(
    /(^|[\s'’-])(\p{Ll})/gu,
    (_, avant, lettre) => avant + lettre.toUpperCase(),
  );
}

/**
 * Construit la phrase d'accueil, mot pour mot.
 *
 * La civilité peut être vide : la formule est alors neutre, ce qui reste correct
 * et ne suppose rien du genre de la personne. Le nom, lui, vient toujours de la
 * base — il n'est jamais écrit en dur.
 */
function construirePhraseAccueil({ nom, civilite }) {
  const appellation = [civilite, formaterNom(nom)].filter(Boolean).join(' ').trim();
  const salutation = appellation ? `Bonjour ${appellation}` : 'Bonjour';
  return `${salutation}, j'espère que vous allez bien. `
    + "Voulez-vous que je vous fasse un débriefing des mouvements d'hier ?";
}

module.exports = { construirePhraseAccueil, formaterNom };

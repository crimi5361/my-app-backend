// Assistant Fondateur — forme 3D a afficher pendant une action (2026-08-13).
//
// L'ecran vocal montre un solide qui prend la forme de ce que l'assistante est
// en train de faire. Trois formes seulement, plus la sphere au repos : au-dela,
// le fondateur ne les distingue plus et l'effet se retourne contre lui.
//
// CHOIX DE CONCEPTION — la forme est deduite de CE QUE L'ASSISTANTE FAIT, jamais
// des mots prononces par le fondateur. Deux raisons :
//   * la reconnaissance vocale se trompe, et « caisse » entendu « laisse »
//     afficherait n'importe quoi ;
//   * une question peut etre posee de mille manieres, alors qu'elle n'aboutit
//     qu'a un petit nombre d'outils. Regarder ce qui s'execute reellement est
//     plus fiable que d'analyser une phrase.
//
// Les libelles sont partages tels quels avec le frontend (BlobVocal.tsx) : toute
// forme ajoutee ici doit y avoir sa geometrie, sinon elle retombe sur la sphere.

const SPHERE = 'sphere';

/** Forme associee a chaque outil. */
const PAR_OUTIL = {
  executer_sql: 'base',              // cylindre a bourrelets
  afficher_graphique: 'graphe',      // histogramme en gradins
  generer_excel: 'livre',            // ouvrage relie
  generer_rapport_audit: 'livre',
};

/**
 * Determine la forme a afficher pour un appel d'outil.
 *
 * @param {string} nomOutil
 * @returns {string} identifiant de forme, jamais nul
 */
function formePour(nomOutil) {
  return PAR_OUTIL[nomOutil] || SPHERE;
}

module.exports = { formePour, SPHERE };

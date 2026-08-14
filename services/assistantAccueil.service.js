// Accueil nominatif de l'assistante (2026-08-14).
//
// L'assistante ouvre la conversation en s'adressant à l'utilisateur par son nom.
//
// LE NOM VIENT DU SERVEUR, JAMAIS DU NAVIGATEUR. Le jeton porte l'identifiant,
// pas le nom : celui-ci est relu en base à chaque ouverture. C'est la seule
// façon d'être sûr que l'assistante salue bien la personne connectée, et non
// celle qu'un `localStorage` prétend être.
//
// LA CIVILITÉ VIENT DES RÉGLAGES. La table `utilisateur` ne porte aucun genre :
// ni colonne `civilite`, ni `sexe`. Écrire « Monsieur » en dur obligerait à
// redéployer le jour où une femme occupe le poste — voir la migration
// 2026-08-14_assistant_civilite.sql.
//
// Le texte lui-même est dans assistantAccueilTexte.js, sans dépendance.
const db = require('../config/db.config');
const { getReglages } = require('./assistantReglages.service');
const { construirePhraseAccueil, formaterNom } = require('./assistantAccueilTexte');

/**
 * Prépare l'accueil d'un utilisateur.
 *
 * @returns {Promise<{nom:string, civilite:string, phrase:string}>}
 */
async function preparerAccueil({ utilisateurId, siteId }) {
  const [reglages, personne] = await Promise.all([
    getReglages(siteId),
    utilisateurId
      ? db.query('SELECT nom FROM utilisateur WHERE id = $1', [utilisateurId])
      : Promise.resolve({ rows: [] }),
  ]);

  const nom = personne.rows[0]?.nom || '';
  const civilite = reglages.civilite ?? 'Monsieur';

  return {
    nom: formaterNom(nom),
    civilite,
    phrase: construirePhraseAccueil({ nom, civilite }),
  };
}

module.exports = { preparerAccueil, construirePhraseAccueil, formaterNom };

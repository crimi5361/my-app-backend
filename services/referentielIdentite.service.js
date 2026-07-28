// Validation serveur des champs d'identité désormais saisis via des listes déroulantes côté
// frontend (Admission Web + Vérification Admission/Réinscription) — le Select frontend guide la
// saisie, mais le backend reste seul juge de ce qui est enregistré : un appel API direct avec une
// valeur hors référentiel doit être rejeté ici, pas seulement empêché visuellement.
const db = require('../config/db.config');

const SEXES_VALIDES = ['Masculin', 'Féminin'];

// identite : objet partiel (seuls les champs présents et non vides sont contrôlés) — ne bloque
// jamais un champ absent, cohérent avec le pattern COALESCE déjà utilisé pour ces mises à jour.
//
// valeursActuelles (optionnel) : ligne etudiant déjà en base. Une grande partie du parc
// existant a été saisie avant l'introduction de ces référentiels (ex. nationalite stockée en
// code ISO type "CI" plutôt qu'en adjectif "Ivoirien(ne)") — resoumettre tel quel un dossier
// existant sans toucher à ce champ ne doit jamais être bloqué rétroactivement. Seule une
// véritable saisie NOUVELLE (valeur différente de l'existant) est confrontée au référentiel.
exports.validerReferentielsIdentite = async (identite, valeursActuelles = {}) => {
  const invalides = [];
  if (!identite || typeof identite !== 'object') return invalides;

  const estNouvelleValeur = (champ) => identite[champ] && identite[champ] !== valeursActuelles?.[champ];

  if (estNouvelleValeur('sexe') && !SEXES_VALIDES.includes(identite.sexe)) {
    invalides.push('sexe');
  }
  if (estNouvelleValeur('nationalite')) {
    const r = await db.query('SELECT 1 FROM pays WHERE nationalite = $1 LIMIT 1', [identite.nationalite]);
    if (r.rows.length === 0) invalides.push('nationalite');
  }
  if (estNouvelleValeur('pays_naissance')) {
    const r = await db.query('SELECT 1 FROM pays WHERE nom = $1 LIMIT 1', [identite.pays_naissance]);
    if (r.rows.length === 0) invalides.push('pays_naissance');
  }
  if (estNouvelleValeur('serie_bac')) {
    const r = await db.query('SELECT 1 FROM serie_bac WHERE nom = $1 LIMIT 1', [identite.serie_bac]);
    if (r.rows.length === 0) invalides.push('serie_bac');
  }
  if (estNouvelleValeur('etablissement_origine')) {
    const r = await db.query('SELECT 1 FROM etablissement_origine WHERE nom_etablissement = $1 LIMIT 1', [identite.etablissement_origine]);
    if (r.rows.length === 0) invalides.push('etablissement_origine');
  }
  return invalides;
};

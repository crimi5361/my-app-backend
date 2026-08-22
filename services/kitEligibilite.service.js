// Chantier Kit étudiant — Phase 1 (2026-08-21) : détermination fiable des niveaux non concernés
// par l'obligation Kit (rames + marqueurs).
//
// Décision validée après audit : niveau.ordre est relatif à la chaîne de curriculum d'une filière
// précise, PAS à l'année d'étude globale (vérifié en base : LICENCE 3/LICENCE 1 PRO/etc. ont des
// `ordre` différents selon la filière — 1, 3 ou 5 selon les parcours). La seule comparaison fiable
// est une correspondance EXACTE sur niveau.libelle, jamais une regex ni une correspondance
// partielle. Même normalisation (trim + toUpperCase) que regleDistribution.controller.js::
// validerNiveauLibelle — précédent déjà établi dans ce projet, pas une invention.
//
// Indépendant du module Moyens Généraux : ce service n'importe rien de ce module et n'est importé
// par rien de ce module.
const NIVEAUX_PREMIERE_ANNEE = ['LICENCE 1', 'BTS 1', 'LICENCE 1 PRO'];

// executor : pool `db` ou client de transaction déjà ouvert (même interface `.query()`), sur le
// même modèle que kitCampagne.service.js::isKitSuspenduPourAnnee.
async function estPremiereAnnee(executor, niveauId) {
  const result = await executor.query('SELECT libelle FROM niveau WHERE id = $1', [niveauId]);
  if (result.rows.length === 0) {
    throw new Error('Niveau introuvable.');
  }
  const libelle = (result.rows[0].libelle || '').trim().toUpperCase();
  return NIVEAUX_PREMIERE_ANNEE.includes(libelle);
}

module.exports = { NIVEAUX_PREMIERE_ANNEE, estPremiereAnnee };

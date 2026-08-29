// Chantier Kit étudiant — Phase 1 (2026-08-21), puis retrait de l'exemption 1ère année (2026-08-29).
//
// Règle métier validée le 2026-08-29 : il n'existe plus d'exemption automatique du Kit pour les
// étudiants de 1ère année (LICENCE 1 / BTS 1 / LICENCE 1 PRO) — ils sont désormais traités
// exactement comme les autres niveaux éligibles (KIT_APPORTE / KIT_PAYE). La constante
// NIVEAUX_PREMIERE_ANNEE et la fonction estPremiereAnnee qui portaient cette règle ont donc été
// retirées d'ici (tous les appelants vérifiés : controllers/kit.controller.js,
// services/kitStatistiques.service.js — aucun autre usage dans le dépôt).
//
// La validation "ce niveau_id existe réellement en base" reste nécessaire indépendamment de cette
// règle métier (cas réel rencontré en audit avant ce chantier : un niveau_id orphelin sur la fiche
// d'un étudiant masquait silencieusement une incohérence de données derrière un comportement
// inattendu) — conservée ici sous validerNiveauExiste, désormais découplée de toute notion de
// "1ère année".
//
// Typée (plutôt qu'une Error générique) pour que les appelants (kit.controller.js) puissent la
// distinguer d'une panne serveur imprévue et répondre 404/422 avec un message diagnosticable, au
// lieu de la laisser remonter en 500 "Erreur serveur." opaque.
class KitEligibiliteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'KitEligibiliteError';
    this.code = code;
  }
}

// executor : pool `db` ou client de transaction déjà ouvert (même interface `.query()`), sur le
// même modèle que kitCampagne.service.js::isKitSuspenduPourAnnee.
async function validerNiveauExiste(executor, niveauId) {
  const result = await executor.query('SELECT id FROM niveau WHERE id = $1', [niveauId]);
  if (result.rows.length === 0) {
    throw new KitEligibiliteError(
      `Niveau introuvable (niveau_id=${niveauId}) pour cet étudiant — sa fiche académique semble incohérente.`,
      'NIVEAU_INTROUVABLE'
    );
  }
}

module.exports = { validerNiveauExiste, KitEligibiliteError };

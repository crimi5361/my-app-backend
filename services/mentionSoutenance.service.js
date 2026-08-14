// Mention obligatoire sur le reçu — frais de soutenance — pour les niveaux Licence 3 et Licence 3
// Pro, une (ou plusieurs) année(s) académique(s) donnée(s). Même principe de configuration que
// kitCampagne.service.js (KIT_ANNEES_SUSPENDUES) : une liste d'années via variable d'environnement,
// pour ne jamais devoir toucher au code l'an prochain — seulement la configuration. Par défaut
// (variable non définie), s'applique à 2026-2027, l'année pour laquelle cette mention a été
// demandée ; à ajuster via MENTION_SOUTENANCE_ANNEES si elle doit un jour couvrir une autre année.
const NIVEAUX_CONCERNES = ['LICENCE 3', 'LICENCE 3 PRO'];

const TEXTE_MENTION =
  "N.B : Prévoir les frais de soutenance d'un montant de 180 000 FCFA à payer avant fin Juin. " +
  "Ce montant tient compte de l'impression du mémoire.";

const anneesConcernees = (process.env.MENTION_SOUTENANCE_ANNEES || '2026-2027')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

// Retourne le texte de la mention si applicable (niveau + année concernés), sinon null — jamais
// affiché pour un autre niveau, jamais pour une autre année académique.
function getMentionSoutenanceSiApplicable(niveauLibelle, anneeAcademiqueLabel) {
  if (!niveauLibelle || !anneeAcademiqueLabel) return null;
  if (!NIVEAUX_CONCERNES.includes(niveauLibelle.trim().toUpperCase())) return null;
  if (!anneesConcernees.includes(anneeAcademiqueLabel)) return null;
  return TEXTE_MENTION;
}

module.exports = { getMentionSoutenanceSiApplicable };

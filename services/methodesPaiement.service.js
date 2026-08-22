// Source unique des moyens de paiement acceptés pour un NOUVEAU paiement (module Caisse et
// module Scolarité).
//
// ⚠️ Ne concerne QUE l'écriture de nouveaux paiements. Les paiements historiques enregistrés
// avec d'autres valeurs ne sont ni modifiés ni supprimés — ils restent consultables tels quels
// dans l'historique, les rapports et les reçus, qui lisent `paiement.methode` sans jamais passer
// par cette liste.
const METHODES_VALIDES_NOUVEAU_PAIEMENT = ['especes', 'Mobile Money', 'Orange Money'];

module.exports = { METHODES_VALIDES_NOUVEAU_PAIEMENT };

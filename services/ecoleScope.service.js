// Chantier 3 — cloisonnement des agents par école. Contrat complet documenté dans
// docs/architecture-permissions-ecole.md : ne pas dupliquer cette logique dans les contrôleurs.
//
// Différence volontaire avec getSiteFromUser (controllers/filieres.controller.js) : celui-ci lève
// une erreur si site_id est vide (site obligatoire), alors qu'ici ecole_id vide (null) est un cas
// valide — il signifie "vue globale", pas une donnée manquante.

function getEcoleScopeFromUser(req) {
  if (!req.user) throw new Error('Utilisateur non authentifié.');
  // req.user.ecole_id est déjà normalisé à null par auth.middleware.js si absent du token ;
  // le ?? ici couvre en plus tout appelant qui construirait req.user sans passer par ce middleware.
  return req.user.ecole_id ?? null;
}

module.exports = { getEcoleScopeFromUser };

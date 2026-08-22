// Permissions par rôle + par utilisateur (Chantier Moyens Généraux, Phase 1 — corrigé le
// 2026-08-19). Deux notions distinctes, jamais confondues :
//
//   rolepermission (role_id, permission_id)       -> CATALOGUE : quelles permissions PEUVENT être
//                                                     configurées pour un rôle donné (ex. seul le
//                                                     rôle 'moyens_generaux' a un catalogue non
//                                                     vide aujourd'hui — migration 029). Un rôle
//                                                     sans catalogue = "Aucune permission
//                                                     configurée pour ce rôle", jamais une erreur.
//   utilisateur_permission (utilisateur_id, ...)   -> ACCÈS RÉEL : quelles permissions du
//                                                     catalogue de son rôle CET utilisateur précis
//                                                     a effectivement reçues. Deux collaborateurs
//                                                     du même rôle peuvent avoir des attributions
//                                                     différentes — c'est tout l'intérêt de cette
//                                                     table (un rôle seul ne suffirait pas).
//
// admin n'a besoin d'aucune ligne dans l'une ou l'autre table : bypass explicite et permanent
// dans middleware/permission.middleware.js, jamais modélisé ici.

// Catalogue des permissions disponibles pour un rôle — utilisé par l'écran d'administration
// (controllers/user.controller.js) pour savoir quoi proposer/valider pour un utilisateur donné.
async function getPermissionsDisponiblesPourRole(client, roleId) {
  const result = await client.query(
    `SELECT p.id, p.nom, p.description
     FROM rolepermission rp
     JOIN permission p ON p.id = rp.permission_id
     WHERE rp.role_id = $1
     ORDER BY p.nom`,
    [roleId]
  );
  return result.rows;
}

// Permissions RÉELLEMENT accordées à un utilisateur précis — source utilisée à la fois par
// controllers/auth.controller.js (calcul embarqué dans le JWT/la réponse de login, consommé par
// middleware/permission.middleware.js) et par l'écran d'administration.
async function getPermissionsUtilisateur(client, utilisateurId) {
  const result = await client.query(
    `SELECT p.nom
     FROM utilisateur_permission up
     JOIN permission p ON p.id = up.permission_id
     WHERE up.utilisateur_id = $1`,
    [utilisateurId]
  );
  return result.rows.map((row) => row.nom);
}

module.exports = { getPermissionsDisponiblesPourRole, getPermissionsUtilisateur };

// Résolution de la session de caisse ouverte d'un caissier — extrait de caisse.controller.js
// (Phase 3 intégration Wave, 2026-08-18) pour être réutilisé par le nouveau contrôleur
// d'initiation de paiement Wave sans dupliquer cette règle. Comportement strictement inchangé.
async function getSessionOuverte(dbClient, userId, siteId) {
  const result = await dbClient.query(
    `SELECT sc.* FROM session_caisse sc
     JOIN caisse c ON c.id = sc.caisse_id
     WHERE sc.caissier_id = $1 AND c.site_id = $2 AND sc.statut = 'OUVERTE'
     ORDER BY sc.date_ouverture DESC LIMIT 1`,
    [userId, siteId]
  );
  return result.rows[0] || null;
}

module.exports = { getSessionOuverte };

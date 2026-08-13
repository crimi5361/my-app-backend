// Dashboard Fondateur (Chantier 2, 2026-08-02, re-scopé par site le 2026-08-02) — pilotage
// stratégique du site du Fondateur connecté. Cahier des charges validé le 2026-08-02 : vue
// globale étudiants/inscriptions, répartitions école/filière/niveau (répartition par département
// retirée le 2026-08-02, redondante avec école ; répartition par site retirée le 2026-08-02, cf.
// note ci-dessous), évolution des inscriptions, situation financière globale (scolarité/versé/
// restant/PEC uniquement, avec graphique d'évolution des recettes sur l'année académique
// complète), vue globale caisses (sans dupliquer le détail du Dashboard Comptabilité), bloc Moyens
// Généraux (Chantier 10, sous-phase 12, 2026-08-03).
//
// Site-scopé comme tout le reste de l'application (req.user.departement_id) — revirement
// architectural assumé le 2026-08-02 : la version initiale de ce contrôleur agrégeait
// volontairement toutes les données de l'institution, au motif qu'"un Fondateur pilote
// l'institution entière". Le client a corrigé ce postulat : un Fondateur est créé PAR site et ne
// doit voir que les données de son propre site, au même titre que tous les autres rôles. Le bloc
// "répartition par site" est donc retiré (il n'aurait plus de sens une fois la vue elle-même
// limitée à un seul site). Le cloisonnement par école (Chantier 3) reste appliqué, cumulatif,
// car indépendant du site.
//
// Requêtes déplacées dans services/fondateurOverview.service.js (Chantier Assistant IA,
// 2026-08-07) — réutilisées telles quelles par les outils (function calling) de l'Assistant
// Fondateur, pour éviter que l'IA ne requête la base autrement que via ces agrégations vetted.
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { getFondateurOverview } = require('../services/fondateurOverview.service');

exports.getDashboardFondateur = async (req, res) => {
  try {
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }

    const data = await getFondateurOverview(db, { anneeAcademiqueId, siteId, ecoleId });
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Erreur getDashboardFondateur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

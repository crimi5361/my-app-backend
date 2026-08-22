const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const stockController = require('../controllers/stock.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

// Aussi accessible avec seulement 'distribution.effectuer' : composer une remise (Distribution.tsx)
// nécessite de connaître les soldes disponibles, sans accès à la page Stock elle-même.
router.get('/', authenticateToken, mgOnly, requireAnyPermission('stock.voir', 'distribution.effectuer'), stockController.getEtatStock);
// Tableau de bord détaillé par article (refonte 2026-08-20) — initial/reçu/distribué/transféré/
// restant/valeur, reconstruit depuis le grand-livre.
router.get('/articles/detail', authenticateToken, mgOnly, requirePermission('stock.voir'), stockController.getDetailArticles);
// Stock initial / reprise de stock à l'ouverture d'une année académique (Phase 2F, 2026-08-20) —
// même permission que l'ajustement d'inventaire (action de même nature : corriger/déclarer un
// solde, pas une permission dédiée).
router.get('/initial', authenticateToken, mgOnly, requirePermission('stock.voir'), stockController.getStockInitial);
router.post('/initial', authenticateToken, mgOnly, requirePermission('stock.ajuster'), stockController.declarerStockInitial);
router.post('/ajustements', authenticateToken, mgOnly, requirePermission('stock.ajuster'), stockController.creerAjustement);
router.get('/mouvements', authenticateToken, mgOnly, requirePermission('stock.voir'), stockController.getMouvements);
// Aussi accessible avec 'distribution.voir' : peuple le filtre "effectué par" de l'historique des
// distributions (HistoriqueDistributions.tsx), pas seulement celui de la page Stock.
router.get('/agents', authenticateToken, mgOnly, requireAnyPermission('stock.voir', 'distribution.voir'), stockController.getAgentsStock);

module.exports = router;

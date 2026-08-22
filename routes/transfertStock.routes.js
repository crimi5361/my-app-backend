const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission } = require('../middleware/permission.middleware');
const transfertStockController = require('../controllers/transfertStock.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

// Chantier Moyens Généraux — Phase 2E (2026-08-19).
// Lecture (liste/détail) : stock.voir (déjà existante — un transfert est une information de
// stock). Création/envoi/annulation (actions du site expéditeur) : transfert.creer. Réception
// (action du site destinataire, agent potentiellement différent) : transfert.receptionner.
router.get('/', authenticateToken, mgOnly, requirePermission('stock.voir'), transfertStockController.getTransferts);
router.get('/:id', authenticateToken, mgOnly, requirePermission('stock.voir'), transfertStockController.getTransfertById);
router.post('/', authenticateToken, mgOnly, requirePermission('transfert.creer'), transfertStockController.creerTransfert);
router.post('/:id/envoyer', authenticateToken, mgOnly, requirePermission('transfert.creer'), transfertStockController.envoyerTransfert);
router.patch('/:id/annuler', authenticateToken, mgOnly, requirePermission('transfert.creer'), transfertStockController.annulerTransfert);
router.post('/:id/receptionner', authenticateToken, mgOnly, requirePermission('transfert.receptionner'), transfertStockController.receptionnerTransfert);

module.exports = router;

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission } = require('../middleware/permission.middleware');
const regleDistributionController = require('../controllers/regleDistribution.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

// Chantier Moyens Généraux — Phase 2B (2026-08-19). Mêmes permissions que le catalogue
// d'accessoires : la configuration des règles fait partie de la gestion du catalogue
// (accessoire.voir / accessoire.gerer), aucune permission dédiée introduite.
//
// Route statique déclarée AVANT '/:id' pour ne pas être capturée par le paramètre.
router.get('/niveaux-disponibles', authenticateToken, mgOnly, requirePermission('accessoire.voir'), regleDistributionController.getNiveauxDisponibles);
router.get('/', authenticateToken, mgOnly, requirePermission('accessoire.voir'), regleDistributionController.getRegles);
router.get('/:id', authenticateToken, mgOnly, requirePermission('accessoire.voir'), regleDistributionController.getRegleById);
router.post('/', authenticateToken, mgOnly, requirePermission('accessoire.gerer'), regleDistributionController.creerRegles);
router.put('/:id', authenticateToken, mgOnly, requirePermission('accessoire.gerer'), regleDistributionController.modifierQuantiteRegle);
router.patch('/:id/activation', authenticateToken, mgOnly, requirePermission('accessoire.gerer'), regleDistributionController.setActivationRegle);

module.exports = router;

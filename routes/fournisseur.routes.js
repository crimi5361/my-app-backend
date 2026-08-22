const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const fournisseurController = require('../controllers/fournisseur.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

// Aussi accessible avec seulement 'commande.gerer' : composer une commande nécessite de choisir
// un fournisseur existant, sans accès dédié à la page Fournisseurs elle-même.
router.get('/', authenticateToken, mgOnly, requireAnyPermission('fournisseur.voir', 'commande.gerer'), fournisseurController.getFournisseurs);
router.post('/', authenticateToken, mgOnly, requirePermission('fournisseur.gerer'), fournisseurController.createFournisseur);
router.put('/:id', authenticateToken, mgOnly, requirePermission('fournisseur.gerer'), fournisseurController.updateFournisseur);
router.patch('/:id/statut', authenticateToken, mgOnly, requirePermission('fournisseur.gerer'), fournisseurController.setStatutFournisseur);

module.exports = router;

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const accessoireController = require('../controllers/accessoire.controller');

// Appartenance au module (inchangé) — la permission ci-dessous affine ENSUITE ce que ce compte
// précis peut faire à l'intérieur (Chantier Moyens Généraux, Phase 1, 2026-08-19).
const mgOnly = authorizeRoles('admin', 'moyens_generaux');

// Aussi accessible avec seulement 'commande.gerer' : composer une commande (Commandes.tsx)
// nécessite de lire le catalogue pour choisir les accessoires commandés, sans que ce compte ait
// besoin d'un accès dédié à la page Accessoires elle-même.
router.get('/', authenticateToken, mgOnly, requireAnyPermission('accessoire.voir', 'commande.gerer'), accessoireController.getAccessoires);
router.post('/', authenticateToken, mgOnly, requirePermission('accessoire.gerer'), accessoireController.createAccessoire);
router.put('/:id', authenticateToken, mgOnly, requirePermission('accessoire.gerer'), accessoireController.updateAccessoire);
router.patch('/:id/statut', authenticateToken, mgOnly, requirePermission('accessoire.gerer'), accessoireController.setStatutAccessoire);

module.exports = router;

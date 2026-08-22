const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission } = require('../middleware/permission.middleware');
const categorieAccessoireController = require('../controllers/categorieAccessoire.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

// Mêmes permissions que le catalogue d'accessoires (Chantier Moyens Généraux, Phase 2A,
// 2026-08-19) : pas de permission dédiée aux catégories — accessoire.voir/accessoire.gerer
// suffisent, la gestion des catégories fait partie de la gestion du catalogue.
router.get('/', authenticateToken, mgOnly, requirePermission('accessoire.voir'), categorieAccessoireController.getCategories);
router.post('/', authenticateToken, mgOnly, requirePermission('accessoire.gerer'), categorieAccessoireController.createCategorie);
router.put('/:id', authenticateToken, mgOnly, requirePermission('accessoire.gerer'), categorieAccessoireController.updateCategorie);
router.patch('/:id/statut', authenticateToken, mgOnly, requirePermission('accessoire.gerer'), categorieAccessoireController.setStatutCategorie);

module.exports = router;

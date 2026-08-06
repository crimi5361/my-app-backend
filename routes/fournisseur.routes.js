const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const fournisseurController = require('../controllers/fournisseur.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

router.get('/', authenticateToken, mgOnly, fournisseurController.getFournisseurs);
router.post('/', authenticateToken, mgOnly, fournisseurController.createFournisseur);
router.put('/:id', authenticateToken, mgOnly, fournisseurController.updateFournisseur);
router.patch('/:id/statut', authenticateToken, mgOnly, fournisseurController.setStatutFournisseur);

module.exports = router;

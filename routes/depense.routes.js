const express = require('express');
const router = express.Router();
const depenseController = require('../controllers/depense.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

// Chantier Comptabilité — Priorité 1, point 3 : traçabilité des sorties d'argent.
// Réservé à la comptabilité/admin, comme le reste du module financier.
const comptabiliteOnly = authorizeRoles('admin', 'comptabilite');

router.get('/categories', authenticateToken, comptabiliteOnly, depenseController.getCategoriesDepense);
router.get('/bilan', authenticateToken, comptabiliteOnly, depenseController.getBilan);
router.get('/', authenticateToken, comptabiliteOnly, depenseController.listerDepenses);
router.post('/', authenticateToken, comptabiliteOnly, depenseController.creerDepense);
router.put('/:id/valider', authenticateToken, comptabiliteOnly, depenseController.validerDepense);
router.put('/:id/annuler', authenticateToken, comptabiliteOnly, depenseController.annulerDepense);

module.exports = router;

const express = require('express');
const router = express.Router();
const anneeController = require('../controllers/annee.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

router.get('/', authenticateToken, anneeController.getAllAnnees);
router.get('/anneeValide', authenticateToken, anneeController.getAllAnneesValide);
router.post('/ajouter', authenticateToken, authorizeRoles('admin'), anneeController.addAnnee);
router.post('/:id/fermer', authenticateToken, authorizeRoles('admin'), anneeController.closeAnnee);
router.post('/:id/reouvrir', authenticateToken, authorizeRoles('admin'), anneeController.reopenAnnee);


module.exports = router;
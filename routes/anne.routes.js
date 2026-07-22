const express = require('express');
const router = express.Router();
const anneeController = require('../controllers/annee.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

router.get('/', authenticateToken, anneeController.getAllAnnees);
router.get('/anneeValide', authenticateToken, anneeController.getAllAnneesValide);
router.get('/site/:siteId', authenticateToken, anneeController.getAnneeEnCoursForSite);
router.post('/ajouter', authenticateToken, authorizeRoles('admin'), anneeController.addAnnee);
router.post('/:anneeId/site/:siteId/ouvrir', authenticateToken, authorizeRoles('admin'), anneeController.ouvrirAnneePourSite);
router.post('/:anneeId/site/:siteId/fermer', authenticateToken, authorizeRoles('admin'), anneeController.fermerAnneePourSite);
router.post('/:anneeId/site/:siteId/reouvrir', authenticateToken, authorizeRoles('admin'), anneeController.reouvrirAnneePourSite);

module.exports = router;

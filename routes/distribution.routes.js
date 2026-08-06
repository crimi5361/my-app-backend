const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const distributionController = require('../controllers/distribution.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

// Routes à segment fixe déclarées AVANT '/:id' — sinon Express les intercepterait comme un id.
router.get('/historique/filtres', authenticateToken, mgOnly, distributionController.getFiltresHistorique);
router.get('/historique', authenticateToken, mgOnly, distributionController.getHistorique);
router.get('/recherche', authenticateToken, mgOnly, distributionController.rechercher);
router.get('/etudiant/:id', authenticateToken, mgOnly, distributionController.getFicheEtudiant);
router.get('/:id', authenticateToken, mgOnly, distributionController.getDistributionById);
router.post('/', authenticateToken, mgOnly, distributionController.creerDistribution);

module.exports = router;

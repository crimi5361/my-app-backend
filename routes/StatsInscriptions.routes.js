const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const statistiquesController = require('../controllers/StatsInscriptions.controller');


// Route principale pour les stats d'inscriptions
router.get('/stats-inscriptions',authenticateToken ,  statistiquesController.getStatsInscriptions);

// Route optionnelle pour les stats détaillées
router.get('/stats-detaillees',authenticateToken ,  statistiquesController.getStatsDetaillees);

module.exports = router;
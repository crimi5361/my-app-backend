const express = require('express');
const router = express.Router();
const statisticsController = require('../controllers/StatistiqueGeneral.controller');
const authenticateToken = require('../middleware/auth.middleware');

// Routes pour les statistiques - le chemin de base est déjà /api/statistiques
router.get('/cycle', authenticateToken, statisticsController.getStatisticsByCycle);
router.get('/niveau', authenticateToken, statisticsController.getStatisticsByNiveau);
router.get('/cursus', authenticateToken, statisticsController.getStatisticsByCursus);
router.get('/filiere', authenticateToken, statisticsController.getStatisticsByFiliere);
router.get('/detailed', authenticateToken, statisticsController.getDetailedStatistics);

module.exports = router;
const express = require('express');
const router = express.Router();
const statisticsController = require('../controllers/StatistiqueGeneral.controller');

// Routes pour les statistiques - le chemin de base est déjà /api/statistiques
router.get('/cycle', statisticsController.getStatisticsByCycle);
router.get('/niveau', statisticsController.getStatisticsByNiveau);
router.get('/cursus', statisticsController.getStatisticsByCursus);
router.get('/filiere', statisticsController.getStatisticsByFiliere);
router.get('/detailed', statisticsController.getDetailedStatistics);

module.exports = router;
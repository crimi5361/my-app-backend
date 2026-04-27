// evaluation.routes.js
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const evaluationController = require('../controllers/evaluation.controller');

// Routes pour les évaluations par groupe
router.get('/groupe/:groupeId', authenticateToken, evaluationController.getEvaluationsByGroupe);
router.get('/detail/:enseignementId', authenticateToken, evaluationController.getEvaluationDetail);
router.get('/statistiques/:groupeId', authenticateToken, evaluationController.getStatistiquesEvaluations);

module.exports = router;
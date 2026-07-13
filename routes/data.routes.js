const express = require('express');
const router = express.Router();
const dataController = require('../controllers/data.controller');
const authenticateToken = require('../middleware/auth.middleware');

// Routes pour les données de référence
router.get('/villes', authenticateToken, dataController.getAllville);
router.get('/series-bac', authenticateToken, dataController.getAllserie);
router.get('/annees-bac', authenticateToken, dataController.getAllannee);
router.get('/pays', authenticateToken, dataController.getAllpays);

module.exports = router;
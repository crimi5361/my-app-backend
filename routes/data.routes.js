const express = require('express');
const router = express.Router();
const dataController = require('../controllers/data.controller');

// Routes pour les données de référence
router.get('/villes', dataController.getAllville);
router.get('/series-bac', dataController.getAllserie);
router.get('/annees-bac', dataController.getAllannee);

module.exports = router;
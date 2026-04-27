// routes/EDT.routes.js
const express = require('express');
const router = express.Router();
const emploiDuTempsController = require('../controllers/EDT.controller');

// CORRECTION : Utilise le même chemin que ton frontend
router.post('/:id/emploi-du-temps', emploiDuTempsController.uploadEmploiDuTemps);
router.get('/:id/emploi-du-temps', emploiDuTempsController.getEmploiDuTemps);
router.get('/emploi-du-temps/:id/download', emploiDuTempsController.downloadEmploiDuTemps);

module.exports = router;
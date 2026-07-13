// routes/EDT.routes.js
const express = require('express');
const router = express.Router();
const emploiDuTempsController = require('../controllers/EDT.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

// CORRECTION : Utilise le même chemin que ton frontend
router.post('/:id/emploi-du-temps', authenticateToken, authorizeRoles('admin', 'scolarite'), emploiDuTempsController.uploadEmploiDuTemps);
router.get('/:id/emploi-du-temps', authenticateToken, emploiDuTempsController.getEmploiDuTemps);
router.get('/emploi-du-temps/:id/download', authenticateToken, emploiDuTempsController.downloadEmploiDuTemps);

module.exports = router;
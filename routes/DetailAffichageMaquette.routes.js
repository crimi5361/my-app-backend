const express = require('express');
const router = express.Router();
const maquetteDetailController = require('../controllers/DetailAffichageMaquette.controller');
const authenticateToken = require('../middleware/auth.middleware');

// Route pour récupérer les détails structurés d'une maquette
router.get('/maquettes/:id/structured', authenticateToken, maquetteDetailController.getMaquetteDetailStructured);

module.exports = router;
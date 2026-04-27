const express = require('express');
const router = express.Router();
const maquetteDetailController = require('../controllers/DetailAffichageMaquette.controller');

// Route pour récupérer les détails structurés d'une maquette
router.get('/maquettes/:id/structured', maquetteDetailController.getMaquetteDetailStructured);

module.exports = router;
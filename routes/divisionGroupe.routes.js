// // routes/divisionGroupeRoutes.js
// const express = require('express');
// const router = express.Router();
// const authenticateToken = require('../middleware/auth.middleware');
// const divisionGroupeController = require('../controllers/divisionGroupe.controller');

// // Diviser les groupes d'une classe
// router.post('/diviser', authenticateToken, divisionGroupeController.diviserGroupes);

// // Obtenir les statistiques des groupes d'une classe
// router.get('/statistiques/:classe_id', authenticateToken, divisionGroupeController.getStatistiquesGroupes);

// module.exports = router;
<<<<<<< HEAD
// routes/carte.route.js
const express = require('express');
const router = express.Router();
const carteController = require('../controllers/cartes.controller');
const authenticateToken = require('../middleware/auth.middleware');

// Routes pour la carte étudiante
router.get('/classes', authenticateToken, carteController.getClasses);
router.get('/classes/:classe_id/groupes', authenticateToken, carteController.getGroupesByClasse);
router.get('/groupes/:groupe_id/etudiants', authenticateToken, carteController.getEtudiantsByGroupe);
router.get('/etudiants/:etudiant_id', authenticateToken, carteController.getEtudiantDetails);
router.get('/annees', authenticateToken, carteController.getAnneesAcademiques);
router.get('/initial-data', authenticateToken, carteController.getCarteInitialData);
=======
const express = require('express');
const router = express.Router();
const cartesController = require('../controllers/cartes.controller');

router.get('/classes', cartesController.getClasses);
router.get('/annees', cartesController.getAnneesAcademiques);
router.get('/etudiants', cartesController.getEtudiantsByClasse);
router.get('/etudiant/:id', cartesController.getEtudiantCarte);
>>>>>>> main

module.exports = router;
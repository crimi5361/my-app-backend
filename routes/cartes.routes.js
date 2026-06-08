const express = require('express');
const router = express.Router();
const cartesController = require('../controllers/cartes.controller');

router.get('/classes', cartesController.getClasses);
router.get('/annees', cartesController.getAnneesAcademiques);
router.get('/etudiants', cartesController.getEtudiantsByClasse);
router.get('/etudiant/:id', cartesController.getEtudiantCarte);

module.exports = router;
// Dans le fichier des routes Matière
const express = require('express');
const router = express.Router();
const matiereController = require('../controllers/matiere.controller');

router.post('/', matiereController.createMatiere);
router.put('/:id', matiereController.updateMatiere);


module.exports = router;
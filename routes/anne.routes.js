const express = require('express');
const router = express.Router();
const anneeController = require('../controllers/annee.controller');

router.get('/', anneeController.getAllAnnees);
router.get('/anneeValide' , anneeController.getAllAnneesValide);
router.post('/ajouter', anneeController.addAnnee);
router.post('/:id/fermer', anneeController.closeAnnee);
router.post('/:id/reouvrir', anneeController.reopenAnnee);


module.exports = router;
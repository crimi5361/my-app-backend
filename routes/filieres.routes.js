const express = require('express');
const router = express.Router();
const filieresController = require('../controllers/filieres.controller');

router.get('/', filieresController.getAllFilieres);
router.get('/table/Filiere', filieresController.getAllFilieresTable);
router.post('/filiere', filieresController.createFiliereAvecNiveaux);



module.exports = router;
const express = require('express');
const router = express.Router();
const matiereController = require('../controllers/matiere.controller');

router.post('/', matiereController.createMatiere); 

module.exports = router;
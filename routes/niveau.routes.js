const express = require('express');
const router = express.Router();
const niveauController = require('../controllers/niveau.controller');

router.get('/:filiereId', niveauController.getNiveauxByFiliere);
router.get('/', niveauController.getAllNiveau);

module.exports = router;
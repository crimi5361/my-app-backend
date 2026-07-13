const express = require('express');
const router = express.Router();
const niveauController = require('../controllers/niveau.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/:filiereId', authenticateToken, niveauController.getNiveauxByFiliere);
router.get('/', authenticateToken, niveauController.getAllNiveau);

module.exports = router;
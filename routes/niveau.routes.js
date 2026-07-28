const express = require('express');
const router = express.Router();
const niveauController = require('../controllers/niveau.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/:filiereId', authenticateToken, niveauController.getNiveauxByFiliere);
router.get('/', authenticateToken, niveauController.getAllNiveau);
router.post('/', authenticateToken, niveauController.createNiveau);
router.put('/:id', authenticateToken, niveauController.updateNiveau);
router.delete('/:id', authenticateToken, niveauController.deleteNiveau);

module.exports = router;
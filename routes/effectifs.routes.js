const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const effectifsController = require('../controllers/effectifs.controller');

router.get('/effectifs', authenticateToken, effectifsController.getEffectifsParFiliereNiveau);
router.get('/annees-academiques', authenticateToken, effectifsController.getAnneesAcademiques);

module.exports = router;
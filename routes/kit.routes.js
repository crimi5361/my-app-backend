const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const kitController = require('../controllers/kit.controller'); 

router.get('/etudiant/:id', authenticateToken, kitController.getKitByEtudiant);
router.get('/etat-campagne/:etudiantId', authenticateToken, kitController.getEtatCampagne);

module.exports = router;
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const kitController = require('../controllers/kit.controller'); 

router.get('/etudiant/:id', authenticateToken, kitController.getKitByEtudiant);

module.exports = router;
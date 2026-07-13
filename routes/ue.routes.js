// Dans le fichier des routes UE
const express = require('express');
const router = express.Router();
const ueController = require('../controllers/ue.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

router.post('/ues', authenticateToken, authorizeRoles('admin', 'scolarite'), ueController.createUE);
router.put('/ues/:id', authenticateToken, authorizeRoles('admin', 'scolarite'), ueController.updateUE);


module.exports = router;
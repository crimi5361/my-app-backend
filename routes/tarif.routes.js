const express = require('express');
const router = express.Router();
const tarifController = require('../controllers/tarif.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

router.get('/', authenticateToken, tarifController.getAllTarifs);
router.get('/niveau/:niveauId', authenticateToken, tarifController.getTarifByNiveau);
router.put('/:id', authenticateToken, authorizeRoles('admin'), tarifController.updateTarif);

module.exports = router;

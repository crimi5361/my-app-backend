const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const stockController = require('../controllers/stock.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

router.get('/', authenticateToken, mgOnly, stockController.getEtatStock);
router.post('/ajustements', authenticateToken, mgOnly, stockController.creerAjustement);
router.get('/mouvements', authenticateToken, mgOnly, stockController.getMouvements);
router.get('/agents', authenticateToken, mgOnly, stockController.getAgentsStock);

module.exports = router;

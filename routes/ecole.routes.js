const express = require('express');
const router = express.Router();
const EcoleController = require('../controllers/ecole.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken, EcoleController.getAllEcoles);
router.get('/:id', authenticateToken, EcoleController.getEcoleById);
router.post('/', authenticateToken, EcoleController.createEcole);
router.put('/:id', authenticateToken, EcoleController.updateEcole);
router.delete('/:id', authenticateToken, EcoleController.deleteEcole);

module.exports = router;

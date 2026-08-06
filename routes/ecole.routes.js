const express = require('express');
const router = express.Router();
const EcoleController = require('../controllers/ecole.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

router.get('/', authenticateToken, EcoleController.getAllEcoles);
router.get('/:id', authenticateToken, EcoleController.getEcoleById);
router.post('/', authenticateToken, authorizeRoles('admin'), EcoleController.createEcole);
router.put('/:id', authenticateToken, authorizeRoles('admin'), EcoleController.updateEcole);
router.delete('/:id', authenticateToken, authorizeRoles('admin'), EcoleController.deleteEcole);

module.exports = router;

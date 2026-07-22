const express = require('express');
const router = express.Router();
const DepartementsController = require('../controllers/departement.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken, DepartementsController.getAllDepartements);
router.get('/:id', authenticateToken, DepartementsController.getDepartementById);
router.post('/', authenticateToken, DepartementsController.createDepartement);
router.put('/:id', authenticateToken, DepartementsController.updateDepartement);
router.delete('/:id', authenticateToken, DepartementsController.deleteDepartement);

module.exports = router;

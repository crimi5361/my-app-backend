const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const accessoireController = require('../controllers/accessoire.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

router.get('/', authenticateToken, mgOnly, accessoireController.getAccessoires);
router.post('/', authenticateToken, mgOnly, accessoireController.createAccessoire);
router.put('/:id', authenticateToken, mgOnly, accessoireController.updateAccessoire);
router.patch('/:id/statut', authenticateToken, mgOnly, accessoireController.setStatutAccessoire);

module.exports = router;

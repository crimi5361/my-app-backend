const express = require('express');
const router = express.Router();
const utilisateurController = require('../controllers/user.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

router.get('/', authenticateToken, authorizeRoles('admin'), utilisateurController.getAllUsers);
router.post('/ajouter', authenticateToken, authorizeRoles('admin'), utilisateurController.createUser);


module.exports = router;

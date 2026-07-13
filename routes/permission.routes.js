const express = require('express');
const router = express.Router();
const permissionController = require('../controllers/permission.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

// Récupérer toutes les permissions
router.get('/', authenticateToken, authorizeRoles('admin'), permissionController.getAllPermissions);

module.exports = router;

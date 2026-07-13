const express = require('express');
const router = express.Router();
const controller = require('../controllers/rolepermission.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

// Associer permissions à un rôle
router.post('/assign', authenticateToken, authorizeRoles('admin'), controller.attribuerPermissionsARole);

// Obtenir les permissions d’un rôle
router.get('/:role_id', authenticateToken, authorizeRoles('admin'), controller.getPermissionsByRoleId);

module.exports = router;

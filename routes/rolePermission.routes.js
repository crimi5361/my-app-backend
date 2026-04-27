const express = require('express');
const router = express.Router();
const controller = require('../controllers/rolepermission.controller');

// Associer permissions à un rôle
router.post('/assign', controller.attribuerPermissionsARole);

// Obtenir les permissions d’un rôle
router.get('/:role_id', controller.getPermissionsByRoleId);

module.exports = router;

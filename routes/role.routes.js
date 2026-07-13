const express = require('express');
const router = express.Router();
const roleController = require('../controllers/role.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

router.get('/', authenticateToken, authorizeRoles('admin'), roleController.getAllRoles);

module.exports = router;

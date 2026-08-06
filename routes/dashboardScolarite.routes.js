const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const dashboardScolariteController = require('../controllers/dashboardScolarite.controller');

router.get(
  '/stats',
  authenticateToken,
  authorizeRoles('admin', 'scolarite'),
  dashboardScolariteController.getDashboardScolarite
);

module.exports = router;

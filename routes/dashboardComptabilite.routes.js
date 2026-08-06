const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const dashboardComptabiliteController = require('../controllers/dashboardComptabilite.controller');

router.get(
  '/stats',
  authenticateToken,
  authorizeRoles('admin', 'comptabilite'),
  dashboardComptabiliteController.getDashboardComptabilite
);

module.exports = router;

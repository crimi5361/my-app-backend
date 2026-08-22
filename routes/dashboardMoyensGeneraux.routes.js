const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission } = require('../middleware/permission.middleware');
const dashboardMoyensGenerauxController = require('../controllers/dashboardMoyensGeneraux.controller');

router.get(
  '/stats',
  authenticateToken,
  authorizeRoles('admin', 'moyens_generaux'),
  requirePermission('dashboard.voir'),
  dashboardMoyensGenerauxController.getDashboardMoyensGeneraux
);

module.exports = router;

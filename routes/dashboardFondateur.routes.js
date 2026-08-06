const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const dashboardFondateurController = require('../controllers/dashboardFondateur.controller');

router.get(
  '/stats',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  dashboardFondateurController.getDashboardFondateur
);

module.exports = router;

const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const dashboardAdministrateurController = require('../controllers/dashboardAdministrateur.controller');

router.get(
  '/stats',
  authenticateToken,
  authorizeRoles('admin'),
  dashboardAdministrateurController.getDashboardAdministrateur
);

module.exports = router;

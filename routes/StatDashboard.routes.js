const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const StatDashboardController = require('../controllers/StatDashboard.controller');

router.get('/stats',authenticateToken, StatDashboardController.getDashboardStats);  

module.exports = router;
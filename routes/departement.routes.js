const express = require('express');
const router = express.Router();
const DepartementsController = require('../controllers/departement.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken, DepartementsController.getAllDepartements);

module.exports = router;

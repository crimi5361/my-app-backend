const express = require('express');
const router = express.Router();
const curcusController = require('../controllers/curcus.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken, curcusController.getAllCursus);

module.exports = router;
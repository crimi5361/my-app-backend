const express = require('express');
const router = express.Router();
const categorieController = require('../controllers/categorie.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken, categorieController.getCategories);

module.exports = router;
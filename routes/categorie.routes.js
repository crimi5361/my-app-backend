const express = require('express');
const router = express.Router();
const categorieController = require('../controllers/categorie.controller');

router.get('/', categorieController.getCategories); 

module.exports = router;
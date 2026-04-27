const express = require('express');
const router = express.Router();
const curcusController = require('../controllers/curcus.controller');   

router.get('/', curcusController.getAllCursus); 

module.exports = router;
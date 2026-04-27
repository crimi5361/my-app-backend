const express = require('express');
const router = express.Router();
const DepartementsController = require('../controllers/departement.controller');

router.get('/', DepartementsController.getAllDepartements); 

module.exports = router;

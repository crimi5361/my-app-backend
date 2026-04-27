const express = require('express');
const router = express.Router();
const ueController = require('../controllers/ue.controller');

router.post('/ues', ueController.createUE);



module.exports = router;
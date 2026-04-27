const express = require('express');
const router = express.Router();
const semestreController = require('../controllers/semestre.controller');

router.get('/', semestreController.getSemestres);   

module.exports = router;
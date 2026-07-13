const express = require('express');
const router = express.Router();
const semestreController = require('../controllers/semestre.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken, semestreController.getSemestres);

module.exports = router;
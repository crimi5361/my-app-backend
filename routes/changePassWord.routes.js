const express = require('express');
const router = express.Router();
const changePassWordController = require('../controllers/changePassWord.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.post('/changePassword', authenticateToken, changePassWordController.changePassword);

module.exports = router;
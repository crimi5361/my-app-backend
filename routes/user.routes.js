const express = require('express');
const router = express.Router();
const utilisateurController = require('../controllers/user.controller');


router.get('/', utilisateurController.getAllUsers);
router.post('/ajouter', utilisateurController.createUser);


module.exports = router;

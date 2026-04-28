// Dans le fichier des routes UE
const express = require('express');
const router = express.Router();
const ueController = require('../controllers/ue.controller');

router.post('/ues', ueController.createUE);
router.put('/ues/:id', ueController.updateUE);


module.exports = router;
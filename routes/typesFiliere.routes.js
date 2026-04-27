const express  = require ('express');
const router = express.Router();
const typesFiliereController = require('../controllers/typesFiliere.controller');

router.get('/', typesFiliereController.getAllTypesFiliere);

module.exports = router;   
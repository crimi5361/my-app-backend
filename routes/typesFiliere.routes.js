const express  = require ('express');
const router = express.Router();
const typesFiliereController = require('../controllers/typesFiliere.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken, typesFiliereController.getAllTypesFiliere);

module.exports = router;   
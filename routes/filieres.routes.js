const express = require('express');
const router = express.Router();
const filieresController = require('../controllers/filieres.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken,              filieresController.getAllFilieres);
router.get('/table/Filiere', authenticateToken, filieresController.getAllFilieresTable);
router.post('/', authenticateToken,            filieresController.createFiliere);
router.put('/:id', authenticateToken,          filieresController.updateFiliere);
router.delete('/:id', authenticateToken,       filieresController.deleteFiliere);
router.post('/:id/dupliquer', authenticateToken, filieresController.dupliquerFiliere);

module.exports = router;
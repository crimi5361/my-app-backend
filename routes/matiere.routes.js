// Dans le fichier des routes Matière
const express = require('express');
const router = express.Router();
const matiereController = require('../controllers/matiere.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

router.post('/', authenticateToken, authorizeRoles('admin', 'scolarite'), matiereController.createMatiere);
router.put('/:id', authenticateToken, authorizeRoles('admin', 'scolarite'), matiereController.updateMatiere);


module.exports = router;
const express = require('express');
const router = express.Router();
const orientationController = require('../controllers/orientationReinscription.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

// Lecture : tout utilisateur authentifié (écran admin de consultation + sélecteurs de formulaire).
router.get('/', authenticateToken, orientationController.listerOrientations);
router.get('/niveaux-origine', authenticateToken, orientationController.listerNiveauxOrigine);
router.get('/niveaux-destination', authenticateToken, orientationController.listerNiveauxDestination);

// Écriture : ADMIN strictement (protection serveur, pas seulement masquée côté frontend).
router.post('/', authenticateToken, authorizeRoles('admin'), orientationController.creerOrientation);
router.put('/:id', authenticateToken, authorizeRoles('admin'), orientationController.modifierOrientation);
router.delete('/:id', authenticateToken, authorizeRoles('admin'), orientationController.supprimerOrientation);

module.exports = router;

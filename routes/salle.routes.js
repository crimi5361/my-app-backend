const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const salleController = require('../controllers/salle.controller');

// Lecture large : le RH et la scolarité consultent les salles, le Chargé Pédagogique
// les alloue. L'écriture reste au périmètre administratif + CP (qui connaît le terrain).
const lecture = authorizeRoles('admin', 'charge_pedagogique', 'rh', 'scolarite');
const ecriture = authorizeRoles('admin', 'charge_pedagogique');

router.get('/', authenticateToken, lecture, salleController.getSalles);
router.get('/disponibilite', authenticateToken, lecture, salleController.getDisponibilite);
router.get('/occupation', authenticateToken, lecture, salleController.getOccupation);
router.post('/', authenticateToken, ecriture, salleController.createSalle);
router.put('/:id', authenticateToken, ecriture, salleController.updateSalle);
router.patch('/:id/statut', authenticateToken, ecriture, salleController.setStatutSalle);

module.exports = router;

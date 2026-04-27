const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const professeurController = require('../controllers/professeurController');

// Routes CRUD pour les professeurs
router.get('/', authenticateToken, professeurController.getAllProfesseurs);
router.post('/', authenticateToken, professeurController.createProfesseur);
router.get('/inactifs', authenticateToken, professeurController.getInactifsProfesseurs);
router.get('/:id', authenticateToken, professeurController.getProfesseurById);
router.post('/:id', authenticateToken, professeurController.updateProfesseur);
router.delete('/:id', authenticateToken, professeurController.softDeleteProfesseur);
router.post('/:id/activate', authenticateToken, professeurController.activateProfesseur);

// Route pour les détails des matières enseignées
router.get('/:id/matieres-detail', authenticateToken, professeurController.getMatieresEnseigneesDetail);

module.exports = router;
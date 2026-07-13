const express = require('express');
const router = express.Router();
const paiementEspaceController = require('../controllers/PaiementEespaceetudiant.controller');
const authenticateToken = require('../middleware/auth.middleware');

// Routes pour les paiements et reçus
router.get('/etudiant/:etudiant_id/paiements', authenticateToken, paiementEspaceController.getPaiementsByEtudiantId);
router.get('/etudiant/paiement/:id', authenticateToken, paiementEspaceController.getPaiementWithRecu);
router.get('/etudiant/:etudiant_id/recus', authenticateToken, paiementEspaceController.getRecusByEtudiantId);
router.get('/etudiant/:etudiant_id/stats', authenticateToken, paiementEspaceController.getPaiementStatsByEtudiantId);
router.get('/etudiant/:etudiant_id/scolarite', authenticateToken, paiementEspaceController.getScolariteByEtudiantId);


module.exports = router;
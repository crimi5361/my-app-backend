const express = require('express');
const router = express.Router();
const paiementEspaceController = require('../controllers/PaiementEespaceetudiant.controller');

// Routes pour les paiements et reçus
router.get('/etudiant/:etudiant_id/paiements', paiementEspaceController.getPaiementsByEtudiantId);
router.get('/etudiant/paiement/:id', paiementEspaceController.getPaiementWithRecu);
router.get('/etudiant/:etudiant_id/recus', paiementEspaceController.getRecusByEtudiantId);
router.get('/etudiant/:etudiant_id/stats', paiementEspaceController.getPaiementStatsByEtudiantId);

module.exports = router;
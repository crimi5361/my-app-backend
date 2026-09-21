const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const CertificatFrequentationController = require('../controllers/CertificatFrequentation.controller');

// Chantier "Impression reçu + certificats" (2026-09-21) — comptabilite/caissier ajoutés pour le
// nouveau flux d'impression combinée (reçu + certificats) depuis /Etudiant/Recu_Payement/:id ;
// admin/scolarite inchangés.
router.get('/CertificatFrequentation/etudiant/:id', authenticateToken, authorizeRoles('admin', 'scolarite', 'comptabilite', 'caissier'), CertificatFrequentationController.getAllCertificatFrequentation);

module.exports = router;
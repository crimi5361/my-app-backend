const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const CertificatScolariteController = require('../controllers/CertificatScolarite.controller');

// Chantier "Impression reçu + certificats" (2026-09-21) — comptabilite/caissier ajoutés pour le
// nouveau flux d'impression combinée (reçu + certificats) depuis /Etudiant/Recu_Payement/:id ;
// admin/scolarite inchangés.
router.get('/certificat/etudiant/:id', authenticateToken, authorizeRoles('admin', 'scolarite', 'comptabilite', 'caissier'), CertificatScolariteController.getAllCertificat);

module.exports = router;
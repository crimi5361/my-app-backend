const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const CertificatScolariteController = require('../controllers/CertificatScolarite.controller');

router.get('/certificat/etudiant/:id', authenticateToken, authorizeRoles('admin', 'scolarite'), CertificatScolariteController.getAllCertificat);

module.exports = router;
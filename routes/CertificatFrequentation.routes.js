const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const CertificatFrequentationController = require('../controllers/CertificatFrequentation.controller');

router.get('/CertificatFrequentation/etudiant/:id', authenticateToken, authorizeRoles('admin', 'scolarite'), CertificatFrequentationController.getAllCertificatFrequentation);

module.exports = router;
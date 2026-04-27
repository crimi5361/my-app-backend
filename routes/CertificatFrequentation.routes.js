const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const CertificatFrequentationController = require('../controllers/CertificatFrequentation.controller');

router.get('/CertificatFrequentation/etudiant/:id',authenticateToken, CertificatFrequentationController.getAllCertificatFrequentation);

module.exports = router;
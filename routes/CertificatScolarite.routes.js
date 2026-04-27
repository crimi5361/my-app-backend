const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const CertificatScolariteController = require('../controllers/CertificatScolarite.controller');

router.get('/certificat/etudiant/:id',authenticateToken, CertificatScolariteController.getAllCertificat);

module.exports = router;
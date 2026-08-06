// Chantier 11 (2026-08-04) — sous-phase finale, point 3.
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const nettoyageController = require('../controllers/nettoyageAdmin.controller');

const adminSeulement = authorizeRoles('admin');

router.get('/dossiers-en-attente', authenticateToken, adminSeulement, nettoyageController.listerDossiersEnAttente);
router.delete('/dossiers-en-attente/admission/:etudiantId', authenticateToken, adminSeulement, nettoyageController.supprimerAdmissionEnAttente);
router.delete('/dossiers-en-attente/reinscription/:reinscriptionId', authenticateToken, adminSeulement, nettoyageController.supprimerReinscriptionEnAttente);

module.exports = router;

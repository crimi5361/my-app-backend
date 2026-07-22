const express = require('express');
const router = express.Router();
const reinscriptionController = require('../controllers/reinscription.controller');
const authenticateToken = require('../middleware/auth.middleware');
const { uploadAdmissionFiles } = require('../middleware/upload');

const upload = uploadAdmissionFiles();

router.get('/recherche', authenticateToken, reinscriptionController.rechercherEtudiant);
router.get('/etudiant/:id', authenticateToken, reinscriptionController.getDossierReinscription);
router.post('/etudiant/:id/finaliser', authenticateToken, upload.any(), reinscriptionController.demanderReinscription);
router.get('/fiche/:reinscriptionId', authenticateToken, reinscriptionController.afficherFicheReinscription);

module.exports = router;

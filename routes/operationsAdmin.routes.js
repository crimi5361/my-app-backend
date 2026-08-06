const express = require('express');
const router = express.Router();
const operationsAdminController = require('../controllers/operationsAdmin.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

const staffOnly = [authenticateToken, authorizeRoles('admin', 'scolarite')];

router.get('/etudiant/:id', staffOnly, operationsAdminController.getSituationEtudiant);
router.get('/etudiant/:id/historique', staffOnly, operationsAdminController.getHistoriqueOperations);
router.post('/etudiant/:id/simuler', staffOnly, operationsAdminController.simulerChangement);
router.post('/etudiant/:id/changer-filiere', staffOnly, operationsAdminController.changerFiliere);
router.post('/etudiant/:id/changer-parcours', staffOnly, operationsAdminController.changerParcours);
router.post('/etudiant/:id/changer-cycle', staffOnly, operationsAdminController.changerCycle);

module.exports = router;

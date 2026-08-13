const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const rh = require('../controllers/rh.controller');
const cp = require('../controllers/chargePedagogique.controller');

const rhOnly = authorizeRoles('admin', 'rh');

router.get('/dashboard', authenticateToken, rhOnly, rh.getDashboard);

// Offres
router.get('/offres', authenticateToken, rhOnly, rh.getOffres);
router.post('/offres', authenticateToken, rhOnly, rh.createOffre);
router.put('/offres/:id', authenticateToken, rhOnly, rh.updateOffre);
router.patch('/offres/:id/statut', authenticateToken, rhOnly, rh.setStatutOffre);

// Candidatures — la lecture réutilise les contrôleurs de la bannette : le filtre de
// périmètre qu'ils appliquent est neutre pour le rôle 'rh' (accès global), inutile d'en
// maintenir une seconde version.
router.get('/candidatures', authenticateToken, rhOnly, cp.getCandidatures);
router.get('/candidatures/:id', authenticateToken, rhOnly, cp.getCandidature);
router.post('/candidatures', authenticateToken, rhOnly, rh.createCandidatureInterne);
router.patch('/candidatures/:id/valider', authenticateToken, rhOnly, rh.validerCandidature);
router.patch('/candidatures/:id/refuser', authenticateToken, rhOnly, rh.refuserCandidature);

// Enseignants recrutés
router.get('/enseignants', authenticateToken, rhOnly, rh.getEnseignants);
router.get('/enseignants/:id', authenticateToken, rhOnly, rh.getEnseignant);
router.patch('/enseignants/:id/statut', authenticateToken, rhOnly, rh.setStatutEnseignant);
router.post('/enseignants/:id/reinitialiser-acces', authenticateToken, rhOnly, rh.reinitialiserAcces);

// Contrats
router.get('/contrats', authenticateToken, rhOnly, rh.getContrats);
router.post('/contrats', authenticateToken, rhOnly, rh.createContrat);
router.put('/contrats/:id', authenticateToken, rhOnly, rh.updateContrat);
router.patch('/contrats/:id/statut', authenticateToken, rhOnly, rh.setStatutContrat);

// Affectations des Chargés Pédagogiques
router.get('/charges-pedagogiques', authenticateToken, rhOnly, rh.getChargesPedagogiques);
router.post('/charges-pedagogiques/affectations', authenticateToken, rhOnly, rh.affecterChargePedagogique);
router.delete('/charges-pedagogiques/affectations/:id', authenticateToken, rhOnly, rh.retirerAffectation);

module.exports = router;

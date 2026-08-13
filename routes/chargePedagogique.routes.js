const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const cp = require('../controllers/chargePedagogique.controller');

// L'admin accompagne le CP sur tous ses écrans (support, paramétrage) ; le RH n'accède
// qu'à la lecture des candidatures, qu'il traite depuis son propre espace.
const cpOnly = authorizeRoles('admin', 'charge_pedagogique');
const cpEtRh = authorizeRoles('admin', 'charge_pedagogique', 'rh');

router.get('/perimetre', authenticateToken, cpOnly, cp.getMonPerimetre);
router.get('/classes', authenticateToken, cpEtRh, cp.getMesClasses);
router.get('/classes/:id/matieres', authenticateToken, cpEtRh, cp.getMatieresDeLaClasse);
router.get('/enseignants-planifiables', authenticateToken, cpOnly, cp.getEnseignantsPlanifiables);
router.get('/dashboard', authenticateToken, cpOnly, cp.getDashboard);

router.get('/besoins', authenticateToken, cpEtRh, cp.getBesoins);
router.post('/besoins', authenticateToken, cpOnly, cp.createBesoin);
router.put('/besoins/:id', authenticateToken, cpOnly, cp.updateBesoin);
router.patch('/besoins/:id/statut', authenticateToken, cpOnly, cp.setStatutBesoin);

router.get('/candidatures', authenticateToken, cpEtRh, cp.getCandidatures);
router.get('/candidatures/:id', authenticateToken, cpEtRh, cp.getCandidature);
router.patch('/candidatures/:id/evaluer', authenticateToken, cpOnly, cp.evaluerCandidature);

module.exports = router;

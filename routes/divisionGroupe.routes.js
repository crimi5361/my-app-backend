// Découpage manuel des classes en groupes (Chantier 6, 2026-08-01) — voir
// controllers/divisionGroupe.controller.js. Réécriture complète du brouillon précédent (jamais
// branché à l'application) : accès restreint (admin/scolarite) contrairement au brouillon, qui
// n'avait que authenticateToken.
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const divisionGroupeController = require('../controllers/divisionGroupe.controller');

const peutDecouperGroupes = authorizeRoles('admin', 'scolarite');
// Sous-phase 4.5 (2026-08-03) : l'écran "Gestion des groupes" devient réservé à l'administrateur
// — restriction volontairement plus stricte que l'ancien découpage bulk ci-dessus (jamais branché
// à un frontend, laissé tel quel), donc un middleware séparé plutôt qu'un changement de
// `peutDecouperGroupes` qui aurait aussi retiré l'accès de scolarite à ces anciennes routes.
const peutGererGroupesPedagogiques = authorizeRoles('admin');

router.post('/classes/:classeId/groupes/repartir', authenticateToken, peutDecouperGroupes, divisionGroupeController.decouperClasseEnGroupes);
router.get('/classes/:classeId/groupes/etat', authenticateToken, peutDecouperGroupes, divisionGroupeController.getEtatDecoupage);

// Chantier 11 (2026-08-03) — sous-phase 3 puis 4.5 : écran "Gestion des groupes" (Groupe primaire).
router.get('/classes', authenticateToken, peutGererGroupesPedagogiques, divisionGroupeController.listerClassesGestionGroupes);
router.get('/classes/:classeId', authenticateToken, peutGererGroupesPedagogiques, divisionGroupeController.getDetailClasseGestionGroupes);
router.post('/classes/:classeId/groupes', authenticateToken, peutGererGroupesPedagogiques, divisionGroupeController.creerGroupePedagogiqueHandler);
router.put('/classes/:classeId/groupes/:groupeId', authenticateToken, peutGererGroupesPedagogiques, divisionGroupeController.modifierGroupePedagogiqueHandler);
router.delete('/classes/:classeId/groupes/:groupeId', authenticateToken, peutGererGroupesPedagogiques, divisionGroupeController.supprimerGroupePedagogiqueHandler);
router.post('/classes/:classeId/groupes/:groupeId/etudiants', authenticateToken, peutGererGroupesPedagogiques, divisionGroupeController.deplacerEtudiantsHandler);

module.exports = router;

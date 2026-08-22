const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const demandeSurplusController = require('../controllers/demandeSurplus.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

// Chantier Moyens Généraux — Phase 2D (2026-08-19).
// Lecture : distribution.voir (même permission que l'historique des distributions — une demande de
// surplus est une forme de distribution). Création : distribution.surplus.creer (nouvelle,
// distincte — engage un montant à faire payer, validée avec l'utilisateur avant migration).
// Distribution d'une demande déjà payée : distribution.effectuer (même geste physique qu'une
// distribution gratuite, aucune permission dédiée nécessaire).
router.get('/', authenticateToken, mgOnly, requirePermission('distribution.voir'), demandeSurplusController.getDemandes);
router.get('/:id', authenticateToken, mgOnly, requirePermission('distribution.voir'), demandeSurplusController.getDemandeById);
router.post('/', authenticateToken, mgOnly, requirePermission('distribution.surplus.creer'), demandeSurplusController.creerDemande);
router.patch('/:id/annuler', authenticateToken, mgOnly, requireAnyPermission('distribution.surplus.creer', 'distribution.effectuer'), demandeSurplusController.annulerDemande);
router.post('/:id/distribuer', authenticateToken, mgOnly, requirePermission('distribution.effectuer'), demandeSurplusController.distribuerSurplus);

module.exports = router;

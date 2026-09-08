const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const distributionController = require('../controllers/distribution.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

// Routes à segment fixe déclarées AVANT '/:id' — sinon Express les intercepterait comme un id.
router.get('/historique/filtres', authenticateToken, mgOnly, requirePermission('distribution.voir'), distributionController.getFiltresHistorique);
router.get('/historique', authenticateToken, mgOnly, requirePermission('distribution.voir'), distributionController.getHistorique);
// Chantier "Suivi des distributions" (Phase 1 backend, 2026-09-07) — même permission que
// l'historique (lecture), endpoint distinct : voir controllers/distribution.controller.js::getSuivi.
router.get('/suivi', authenticateToken, mgOnly, requirePermission('distribution.voir'), distributionController.getSuivi);
// Chantier "Suivi des accessoires par niveau" — dashboard Moyens Généraux (2026-09-08). Même
// permission de lecture que /suivi et /historique.
router.get('/statistiques-par-niveau', authenticateToken, mgOnly, requirePermission('distribution.voir'), distributionController.getStatistiquesParNiveau);
router.get('/non-recuperateurs', authenticateToken, mgOnly, requirePermission('distribution.voir'), distributionController.getNonRecuperateurs);
// Chantier Moyens Généraux, Phase 2D (2026-08-19) : aussi accessible avec 'distribution.surplus.creer'
// seule — rechercher un étudiant est le même premier geste pour composer une distribution gratuite
// OU pour créer une demande de surplus, un collaborateur habilité uniquement au surplus doit
// pouvoir l'utiliser sans qu'on lui accorde aussi distribution.effectuer.
router.get('/recherche', authenticateToken, mgOnly, requireAnyPermission('distribution.effectuer', 'distribution.surplus.creer'), distributionController.rechercher);
router.get('/etudiant/:id', authenticateToken, mgOnly, requirePermission('distribution.effectuer'), distributionController.getFicheEtudiant);
// Reçu de remise consolidé (Chantier Moyens Généraux, Phase 2D — ajustements, 2026-08-19) — état
// complet des remises (gratuites + surplus) d'un étudiant pour une année, distinct du reçu d'une
// session précise (GET /:id, inchangé). Même permission que ce dernier.
router.get('/etudiant/:id/recu-consolide', authenticateToken, mgOnly, requireAnyPermission('distribution.voir', 'distribution.effectuer'), distributionController.getRecuConsolideEtudiant);
// Consultation d'une remise précise — utilisée à la fois en composant une nouvelle distribution
// (retrouver une remise existante par n° de reçu) et depuis l'historique/le reçu imprimable :
// légitime avec l'une ou l'autre permission.
router.get('/:id', authenticateToken, mgOnly, requireAnyPermission('distribution.voir', 'distribution.effectuer'), distributionController.getDistributionById);
router.post('/', authenticateToken, mgOnly, requirePermission('distribution.effectuer'), distributionController.creerDistribution);

module.exports = router;

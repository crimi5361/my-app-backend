const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { requirePermission } = require('../middleware/permission.middleware');
const commandeController = require('../controllers/commandeFournisseur.controller');
const receptionController = require('../controllers/reception.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

router.get('/', authenticateToken, mgOnly, requirePermission('commande.voir'), commandeController.getCommandes);
router.get('/:id', authenticateToken, mgOnly, requirePermission('commande.voir'), commandeController.getCommandeById);
router.post('/', authenticateToken, mgOnly, requirePermission('commande.gerer'), commandeController.createCommande);
router.put('/:id', authenticateToken, mgOnly, requirePermission('commande.gerer'), commandeController.updateCommande);
router.patch('/:id/statut', authenticateToken, mgOnly, requirePermission('commande.gerer'), commandeController.setStatutCommande);

// Réceptions (sous-phase 7) — sous-ressource d'une commande. Consulter l'historique des
// réceptions fait partie de "voir une commande" ; en enregistrer une nouvelle est l'action
// sensible distincte demandée explicitement (Phase 1, §2).
router.get('/:id/receptions', authenticateToken, mgOnly, requirePermission('commande.voir'), receptionController.getReceptionsCommande);
router.post('/:id/receptions', authenticateToken, mgOnly, requirePermission('reception.effectuer'), receptionController.creerReception);

module.exports = router;

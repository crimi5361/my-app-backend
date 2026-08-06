const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const commandeController = require('../controllers/commandeFournisseur.controller');
const receptionController = require('../controllers/reception.controller');

const mgOnly = authorizeRoles('admin', 'moyens_generaux');

router.get('/', authenticateToken, mgOnly, commandeController.getCommandes);
router.get('/:id', authenticateToken, mgOnly, commandeController.getCommandeById);
router.post('/', authenticateToken, mgOnly, commandeController.createCommande);
router.put('/:id', authenticateToken, mgOnly, commandeController.updateCommande);
router.patch('/:id/statut', authenticateToken, mgOnly, commandeController.setStatutCommande);

// Réceptions (sous-phase 7) — sous-ressource d'une commande.
router.get('/:id/receptions', authenticateToken, mgOnly, receptionController.getReceptionsCommande);
router.post('/:id/receptions', authenticateToken, mgOnly, receptionController.creerReception);

module.exports = router;

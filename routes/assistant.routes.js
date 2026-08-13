const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const assistantController = require('../controllers/assistant.controller');

router.post(
  '/chat',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.chat
);

// Consommation du mois en cours (plafond applicatif — voir services/assistantBudget.service.js)
router.get(
  '/budget',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.budget
);

// Fichiers produits par l'assistant (classeurs, rapports d'audit).
router.get(
  '/fichier/:id',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.telecharger
);

// --- Rattachement du compte Google (agenda, Meet, messagerie) ---------------
router.get(
  '/google/statut',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.googleStatut
);
router.post(
  '/google/connexion',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.googleConnexion
);
// Pas de authenticateToken : le navigateur arrive depuis google.com sans en-tête
// Authorization. C'est le paramètre `state`, à usage unique et lié à un
// utilisateur, qui authentifie ce retour.
router.get('/google/retour', assistantController.googleRetour);
router.delete(
  '/google/deconnexion',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.googleDeconnexion
);

module.exports = router;

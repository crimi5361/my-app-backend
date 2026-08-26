const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const assistantController = require('../controllers/assistant.controller');
const assistantConsoleController = require('../controllers/assistantConsole.controller');

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

// Sigles et corrections de dictée — lus par le navigateur pour corriger le texte
// dicté dans le chat écrit, qui ne passe pas par le serveur.
router.get(
  '/vocabulaire',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.vocabulaire
);

router.get(
  '/point-du-jour',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.pointDuJour
);

// --- Réglages de l'assistante (prénom, ouverture du mode vocal) ------------
router.get(
  '/reglages',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.reglages
);
router.put(
  '/reglages',
  authenticateToken,
  authorizeRoles('admin', 'fondateur'),
  assistantController.majReglages
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

// --- Console d'administration -----------------------------------------------
//
// ADMIN SEUL, ET LE FONDATEUR EN EST EXCLU alors qu'il a accès à tout le reste
// de l'assistante. Ce n'est pas une précaution de principe : ces écrans parlent
// de modèles, de crédits et de facturation, c'est-à-dire exactement ce que le
// fondateur ne doit jamais apprendre. Lui ouvrir ces routes réduirait à néant
// tout ce que l'instruction système s'applique à taire.
router.get(
  '/console/sante',
  authenticateToken,
  authorizeRoles('admin'),
  assistantConsoleController.sante
);
router.get(
  '/console/couverture',
  authenticateToken,
  authorizeRoles('admin'),
  assistantConsoleController.couverture
);
router.get(
  '/console/couverture/:vue',
  authenticateToken,
  authorizeRoles('admin'),
  assistantConsoleController.echantillon
);
router.get(
  '/console/credits',
  authenticateToken,
  authorizeRoles('admin'),
  assistantConsoleController.credits
);
router.post(
  '/console/recharge',
  authenticateToken,
  authorizeRoles('admin'),
  assistantConsoleController.ajouterRecharge
);
router.put(
  '/console/seuil',
  authenticateToken,
  authorizeRoles('admin'),
  assistantConsoleController.majSeuil
);

module.exports = router;

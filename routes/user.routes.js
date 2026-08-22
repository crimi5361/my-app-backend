const express = require('express');
const router = express.Router();
const utilisateurController = require('../controllers/user.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

router.get('/', authenticateToken, authorizeRoles('admin'), utilisateurController.getAllUsers);
router.post('/ajouter', authenticateToken, authorizeRoles('admin'), utilisateurController.createUser);
router.put('/:id', authenticateToken, authorizeRoles('admin'), utilisateurController.updateUser);
// Désactivation logique (jamais de suppression physique) — voir user.controller.js::deactivateUser.
router.patch('/:id/desactiver', authenticateToken, authorizeRoles('admin'), utilisateurController.deactivateUser);
router.patch('/:id/reactiver', authenticateToken, authorizeRoles('admin'), utilisateurController.reactivateUser);

// Permissions individuelles (Chantier Moyens Généraux, Phase 1) — réservé à admin, même principe
// que la création de compte : seul admin gère qui peut faire quoi.
router.get('/:id/permissions', authenticateToken, authorizeRoles('admin'), utilisateurController.getPermissionsUtilisateur);
router.put('/:id/permissions', authenticateToken, authorizeRoles('admin'), utilisateurController.setPermissionsUtilisateur);

module.exports = router;

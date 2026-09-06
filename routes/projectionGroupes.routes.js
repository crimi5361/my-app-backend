// Chantier "Projection des listes de classes prévisionnelles" (2026-09-05) — outil isolé, admin
// uniquement (même garde que Gestion des groupes, GestionGroupes.tsx, non modifiée par ce chantier).
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const controller = require('../controllers/projectionGroupes.controller');

const adminSeulement = authorizeRoles('admin');

router.get('/niveaux-cibles', authenticateToken, adminSeulement, controller.listerNiveauxCibles);
router.post('/generer', authenticateToken, adminSeulement, controller.genererProjection);
router.get('/', authenticateToken, adminSeulement, controller.getProjection);

module.exports = router;

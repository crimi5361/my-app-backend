const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const effectifsController = require('../controllers/effectifs.controller');

router.get('/effectifs', authenticateToken, effectifsController.getEffectifsParFiliereNiveau);
router.get('/annees-academiques', authenticateToken, effectifsController.getAnneesAcademiques);
// Chantier "Filtre Groupe" (2026-09-07) — lecture seule, alimente le filtre Groupe de Suivi des
// distributions / Gestion des Kits. Distinct de /api/decoupage/classes (admin uniquement, écran de
// gestion), volontairement inchangé.
router.get('/groupes', authenticateToken, effectifsController.getGroupesParAnnee);

module.exports = router;
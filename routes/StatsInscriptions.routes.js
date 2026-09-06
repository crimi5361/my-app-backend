const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const statistiquesController = require('../controllers/StatsInscriptions.controller');


// Route principale pour les stats d'inscriptions — expose la performance nominative des agents
// (audit "Activité des agents", 2026-09-06) : restreinte comme /api/dashboard/scolarite/stats,
// jamais accessible à un compte étudiant.
router.get('/stats-inscriptions', authenticateToken, authorizeRoles('admin', 'scolarite'), statistiquesController.getStatsInscriptions);

// Route optionnelle pour les stats détaillées
router.get('/stats-detaillees',authenticateToken ,  statistiquesController.getStatsDetaillees);

module.exports = router;
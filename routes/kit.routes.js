const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const kitController = require('../controllers/kit.controller');

// Chantier Kit étudiant — Phase 1 (2026-08-21) : le Kit est un processus Caisse, jamais Moyens
// Généraux. Réutilise exactement les mêmes groupes de rôles que routes/caisse.routes.js — aucune
// permission dédiée créée (audit §9 : "ne crée pas une permission dédiée sans justification").
const caisseOuScolariteLecture = authorizeRoles('admin', 'comptabilite', 'caissier', 'scolarite');
const caisseOnly = authorizeRoles('admin', 'comptabilite', 'caissier');

router.get('/rechercher', authenticateToken, caisseOuScolariteLecture, kitController.rechercherEtudiantsKit);
// Chantier "Suivi des kits" (Phase 1 backend, 2026-09-07) — liste paginée/filtrée, même groupe de
// rôles que la recherche existante, aucune nouvelle permission.
router.get('/liste', authenticateToken, caisseOuScolariteLecture, kitController.listerKits);
router.get('/etudiant/:id', authenticateToken, caisseOuScolariteLecture, kitController.getKitByEtudiant);
router.get('/etudiant/:id/etat', authenticateToken, caisseOuScolariteLecture, kitController.getEtatKitEtudiant);
router.get('/etat-campagne/:etudiantId', authenticateToken, caisseOuScolariteLecture, kitController.getEtatCampagne);
router.post('/traiter', authenticateToken, caisseOnly, kitController.traiterKit);

module.exports = router;

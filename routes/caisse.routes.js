const express = require('express');
const router = express.Router();
const caisseController = require('../controllers/caisse.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');

const caisseOnly = authorizeRoles('admin', 'comptabilite', 'caissier');
// Lecture seule de l'historique financier d'un étudiant : la Fiche Étudiant (Chantier V1,
// 2026-08) l'affiche aussi pour le rôle scolarite, qui n'a par ailleurs aucun accès caisse
// (pas de session à ouvrir) — n'élargit que les 2 routes de LECTURE, jamais l'écriture d'un
// paiement (restée strictement caisseOnly juste en dessous).
const caisseOuScolariteLecture = authorizeRoles('admin', 'comptabilite', 'caissier', 'scolarite');

router.get('/reinscription/recherche', authenticateToken, caisseOnly, caisseController.rechercherDossierParCode);
router.post('/reinscription/:code/valider', authenticateToken, caisseOnly, caisseController.validerPaiementReinscription);

router.get('/session/active', authenticateToken, caisseOnly, caisseController.getSessionActive);
router.post('/session/ouvrir', authenticateToken, caisseOnly, caisseController.ouvrirSession);
router.post('/session/:id/fermer', authenticateToken, caisseOnly, caisseController.fermerSession);
router.get('/session/:id/rapport', authenticateToken, caisseOnly, caisseController.getRapportSession);
router.get('/session/:id/rapport/impression', authenticateToken, caisseOnly, caisseController.afficherRapportSession);

router.get('/etudiant/recherche', authenticateToken, caisseOnly, caisseController.rechercherEtudiantCaisse);
router.get('/etudiant/:id/annees', authenticateToken, caisseOuScolariteLecture, caisseController.getHistoriqueAnneesEtudiant);
router.get('/etudiant/:id/annees/:anneeAcademiqueId/paiements', authenticateToken, caisseOuScolariteLecture, caisseController.getPaiementsAnneeEtudiant);
router.post('/etudiant/:id/annees/:anneeAcademiqueId/paiements', authenticateToken, caisseOnly, caisseController.enregistrerPaiementAnneeEtudiant);
router.get('/dashboard/stats', authenticateToken, caisseOnly, caisseController.getDashboardStats);
router.get('/paiements', authenticateToken, caisseOnly, caisseController.getPaiements);
router.get('/inscriptions-en-attente', authenticateToken, caisseOuScolariteLecture, caisseController.getInscriptionsEnAttente);

router.get('/admission/recherche', authenticateToken, caisseOnly, caisseController.rechercherDossierAdmissionParCode);
router.post('/admission/:code/valider', authenticateToken, caisseOnly, caisseController.validerPaiementAdmission);

// Recherche/validation unifiées — un seul champ code côté frontend, dispatché par préfixe (AD-/RI-).
router.get('/recherche', authenticateToken, caisseOnly, caisseController.rechercherDossierParCodeUnifie);
router.post('/:code/valider', authenticateToken, caisseOnly, caisseController.validerPaiementUnifie);

module.exports = router;

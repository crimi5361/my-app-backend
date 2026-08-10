// routes/equivalence.routes.js — module Équivalence, Phase 2 (dépôt, consultation, cycle de
// complément). La décision (valider/refuser/annuler) et le service email arrivent en Phase 3.
const express = require('express');
const router = express.Router();
const equivalenceController = require('../controllers/equivalence.controller');
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const { uploadEquivalenceFiles } = require('../middleware/upload');

const upload = uploadEquivalenceFiles();

// ── Public (portail candidat, D:\IIpea) ──────────────────────────────────────────────────
router.get('/documents-requis', equivalenceController.getDocumentsRequis);
router.post('/deposer', upload.any(), equivalenceController.deposerDemande);
router.get('/suivi/:code_suivi', equivalenceController.getSuiviParCode);
router.post('/suivi/:code_suivi/documents', upload.any(), equivalenceController.ajouterDocumentsComplement);

// ── Agent (Scolarité / Administrateur) ───────────────────────────────────────────────────
router.get('/', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.listerDemandes);
router.get('/:id', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.getDemandeById);
router.get('/:id/documents/:documentId', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.getDocumentFile);
router.put('/:id/documents/:documentId/statut', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.marquerStatutDocument);

// ── Phase 3 : décision ────────────────────────────────────────────────────────────────────
router.put('/:id/prendre-en-charge', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.prendreEnCharge);
router.put('/:id/demander-complement', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.demanderComplement);
router.put('/:id/valider', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.validerDemande);
router.put('/:id/rejeter', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.rejeterDemande);
router.put('/:id/annuler', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.annulerDemande);
router.post('/:id/renvoyer-email', authenticateToken, authorizeRoles('admin', 'scolarite'), equivalenceController.renvoyerEmail);

module.exports = router;

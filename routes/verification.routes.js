const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const verificationController = require('../controllers/verification.controller');
const { uploadAdmissionFiles } = require('../middleware/upload');

const upload = uploadAdmissionFiles();
const staffOnly = [authenticateToken, authorizeRoles('admin', 'scolarite')];

/**
 * @swagger
 * tags:
 *   name: Vérification
 *   description: Vérification scolarité des dossiers d'admission Web avant autorisation de paiement
 */

/**
 * @swagger
 * /api/verification/recherche:
 *   get:
 *     summary: Rechercher les dossiers d'admission Web à vérifier
 *     tags: [Vérification]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Matricule, nom ou prénom (2 caractères minimum)
 *       - in: query
 *         name: statut
 *         schema:
 *           type: string
 *           enum: [en_attente, verifies, tous]
 *         description: Filtre de statut de vérification (par défaut en_attente)
 *     responses:
 *       200:
 *         description: Liste des dossiers correspondants
 *       400:
 *         description: Paramètre manquant ou invalide
 */
router.get('/recherche', ...staffOnly, verificationController.rechercherDossierVerification);

/**
 * @swagger
 * /api/verification/etudiant/{id}:
 *   get:
 *     summary: Récupérer le dossier complet d'un candidat Web pour vérification
 *     tags: [Vérification]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Dossier complet (identité, formation, documents, tarif, photo)
 *       400:
 *         description: Dossier hors périmètre (pas une admission Web)
 *       404:
 *         description: Étudiant introuvable
 */
router.get('/etudiant/:id', ...staffOnly, verificationController.getDossierVerification);

/**
 * @swagger
 * /api/verification/etudiant/{id}/confirmer:
 *   post:
 *     summary: Confirmer le dossier (corrections + documents + photo) et autoriser le paiement
 *     tags: [Vérification]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               identite:
 *                 type: object
 *               formation:
 *                 type: object
 *               fourni:
 *                 type: object
 *               observation_verification:
 *                 type: string
 *               photo:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Dossier vérifié, paiement autorisé
 *       400:
 *         description: Champs manquants, parcours requis non fourni, ou dossier hors périmètre
 *       404:
 *         description: Étudiant introuvable
 *       409:
 *         description: Dossier déjà payé et finalisé
 */
router.post(
  '/etudiant/:id/confirmer',
  ...staffOnly,
  (req, res, next) => {
    if (!req.headers['content-type']?.startsWith('multipart/form-data')) {
      return res.status(400).json({ success: false, message: 'Content-Type must be multipart/form-data' });
    }
    next();
  },
  upload.any(),
  verificationController.confirmerVerification
);

/**
 * @swagger
 * /api/verification/reinscription/recherche:
 *   get:
 *     summary: Rechercher les dossiers de réinscription Web à vérifier
 *     tags: [Vérification]
 *     security:
 *       - bearerAuth: []
 */
router.get('/reinscription/recherche', ...staffOnly, verificationController.rechercherReinscriptionVerification);

/**
 * @swagger
 * /api/verification/reinscription/{id}:
 *   get:
 *     summary: Récupérer le dossier complet d'une réinscription Web (id = reinscription.id)
 *     tags: [Vérification]
 *     security:
 *       - bearerAuth: []
 */
router.get('/reinscription/:id', ...staffOnly, verificationController.getReinscriptionVerification);

/**
 * @swagger
 * /api/verification/reinscription/{id}/confirmer:
 *   post:
 *     summary: Confirmer (corriger si besoin) un dossier de réinscription Web et autoriser le paiement
 *     tags: [Vérification]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/reinscription/:id/confirmer',
  ...staffOnly,
  (req, res, next) => {
    if (!req.headers['content-type']?.startsWith('multipart/form-data')) {
      return res.status(400).json({ success: false, message: 'Content-Type must be multipart/form-data' });
    }
    next();
  },
  upload.any(),
  verificationController.confirmerReinscriptionVerification
);

module.exports = router;

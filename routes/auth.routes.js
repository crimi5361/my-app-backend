// routes/auth.routes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const authenticateToken = require('../middleware/auth.middleware');

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Connexion utilisateur (Utilisateur ou Étudiant)
 *     tags:
 *       - Auth
 *     description: |
 *       Permet à un utilisateur (admin, staff) ou un étudiant de se connecter.
 *       Retourne un token JWT + les informations utilisateur.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - mot_de_passe
 *             properties:
 *               email:
 *                 type: string
 *                 example: test@gmail.com....
 *               mot_de_passe:
 *                 type: string
 *                 example: 123456....
 *     responses:
 *       200:
 *         description: Connexion réussie
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     nom:
 *                       type: string
 *                     email:
 *                       type: string
 *                     role:
 *                       type: string
 *                     code:
 *                       type: string
 *                     userType:
 *                       type: string
 *                       example: utilisateur
 *                     departement:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         nom:
 *                           type: string
 *                     prenoms:
 *                       type: string
 *                     statut:
 *                       type: string
 *       401:
 *         description: Email ou mot de passe incorrect
 *       500:
 *         description: Erreur serveur
 */
router.post('/login', authController.login);

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Identité et permissions ACTUELLES de l'utilisateur connecté
 *     tags:
 *       - Auth
 *     description: |
 *       Correction 2026-08-21 — recalcule les permissions depuis utilisateur_permission (jamais
 *       depuis le JWT, figé jusqu'à expiration). Le frontend l'appelle périodiquement pour se
 *       resynchroniser sans reconnexion après une modification de permission par un admin.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Identité et permissions actuelles
 *       401:
 *         description: Token manquant, invalide ou expiré
 *       403:
 *         description: Compte désactivé entre-temps
 */
router.get('/me', authenticateToken, authController.me);

module.exports = router;
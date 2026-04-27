const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const etudiantController = require('../controllers/etudiant.controller');
const { uploadStudentFiles } = require('../middleware/upload');

const upload = uploadStudentFiles();

/**
 * @swagger
 * /api/etudiants/inscription:
 *   post:
 *     summary: Inscription d'un nouvel étudiant
 *     tags: [Étudiants]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - etudiant
 *               - academique
 *               - inscription
 *             properties:
 *               etudiant:
 *                 type: string
 *                 description: JSON string des informations étudiant
 *                 example: '{"nom":"DIALLO","prenoms":"Mamadou Amadou","date_naissance":"1995-05-15","lieu_naissance":"Dakar","sexe":"M","nationalite":"Sénégalaise","telephone":"+221771234567","contact_parent":"+221781234567","lieu_residence":"Dakar"}'
 *               academique:
 *                 type: string
 *                 description: JSON string des informations académiques
 *                 example: '{"matricule":"2024-001","annee_academique_id":1,"annee_bac":"2023","serie_bac":"C"}'
 *               inscription:
 *                 type: string
 *                 description: JSON string des informations d'inscription
 *                 example: '{"niveau_id":1,"id_filiere":5,"montant_scolarite":500000}'
 *               documents:
 *                 type: string
 *                 description: JSON array des documents fournis
 *                 example: '[{"nom":"EXTRAIT_DE_NAISSANCE","fourni":true}]'
 *               photo:
 *                 type: string
 *                 format: binary
 *                 description: Photo de l'étudiant (max 2MB)
 *     responses:
 *       201:
 *         description: Étudiant inscrit avec succès
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     code_unique:
 *                       type: string
 *                     email:
 *                       type: string
 *                     photoUrl:
 *                       type: string
 *                     matricule:
 *                       type: string
 *                     matricule_iipea:
 *                       type: string
 *       400:
 *         description: Champs manquants ou format invalide
 *       401:
 *         description: Authentification requise
 *       409:
 *         description: Doublon détecté
 *       500:
 *         description: Erreur serveur
 */
router.post(
  '/inscription',
  authenticateToken,
  (req, res, next) => {
    if (!req.headers['content-type']?.startsWith('multipart/form-data')) {
      return res.status(400).json({
        error: 'Content-Type must be multipart/form-data'
      });
    }
    next();
  },
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'documents', maxCount: 5 }
  ]),
  etudiantController.addEtudiant
);

/**
 * @swagger
 * /api/etudiants/EtudiantsByDepartement:
 *   post:
 *     summary: Récupérer les étudiants par département
 *     tags: [Étudiants]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: departement_id
 *         schema:
 *           type: integer
 *         description: ID du département (optionnel, utilise celui de l'utilisateur par défaut)
 *       - in: query
 *         name: anneeAcademiqueId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'année académique
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Numéro de page
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Nombre d'éléments par page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Terme de recherche
 *       - in: query
 *         name: standing
 *         schema:
 *           type: string
 *           enum: [Inscrit, en attente, Suspendu, Exclu]
 *           default: Inscrit
 *         description: Statut des étudiants
 *       - in: query
 *         name: filiere
 *         schema:
 *           type: string
 *         description: Nom de la filière
 *       - in: query
 *         name: niveau
 *         schema:
 *           type: string
 *         description: Libellé du niveau
 *     responses:
 *       200:
 *         description: Liste des étudiants récupérée avec succès
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *       400:
 *         description: Paramètres manquants
 *       500:
 *         description: Erreur serveur
 */
router.post(
  '/EtudiantsByDepartement',
  authenticateToken,
  etudiantController.getEtudiantsByDepartement
);

/**
 * @swagger
 * /api/etudiants/ExportEtudiants:
 *   post:
 *     summary: Exporter les étudiants par département
 *     tags: [Étudiants]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: departement_id
 *         schema:
 *           type: integer
 *         description: ID du département
 *       - in: query
 *         name: anneeAcademiqueId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'année académique
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Terme de recherche
 *       - in: query
 *         name: standing
 *         schema:
 *           type: string
 *           enum: [Inscrit, en attente, Suspendu, Exclu]
 *           default: Inscrit
 *       - in: query
 *         name: filiere
 *         schema:
 *           type: string
 *       - in: query
 *         name: niveau
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Export réussi
 *       400:
 *         description: Paramètres manquants
 *       500:
 *         description: Erreur serveur
 */
router.post('/ExportEtudiants', authenticateToken, etudiantController.exportEtudiantsByDepartement);

/**
 * @swagger
 * /api/etudiants/EtudiantsByDepartementEnattente:
 *   get:
 *     summary: Récupérer les étudiants en attente par département
 *     tags: [Étudiants]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: departement_id
 *         schema:
 *           type: integer
 *       - in: query
 *         name: anneeAcademiqueId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: filiere
 *         schema:
 *           type: string
 *       - in: query
 *         name: niveau
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Liste des étudiants en attente
 *       400:
 *         description: Paramètres manquants
 *       500:
 *         description: Erreur serveur
 */
router.get(
  '/EtudiantsByDepartementEnattente',
  authenticateToken,
  etudiantController.getEtudiantsByDepartementEnAttente
);

/**
 * @swagger
 * /api/etudiants/etudiant/{id}:
 *   get:
 *     summary: Récupérer les détails d'un étudiant
 *     tags: [Étudiants]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'étudiant
 *     responses:
 *       200:
 *         description: Détails de l'étudiant
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     nom:
 *                       type: string
 *                     prenoms:
 *                       type: string
 *                     matricule:
 *                       type: string
 *                     filiere:
 *                       type: string
 *                     niveau:
 *                       type: string
 *                     standing:
 *                       type: string
 *       400:
 *         description: ID invalide
 *       404:
 *         description: Étudiant non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/etudiant/:id', authenticateToken, etudiantController.getEtudiantById);

/**
 * @swagger
 * /api/etudiants/recu-data/{id}:
 *   get:
 *     summary: Récupérer les données pour le reçu
 *     tags: [Étudiants]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'étudiant
 *     responses:
 *       200:
 *         description: Données du reçu récupérées
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     etudiant:
 *                       type: object
 *                     paiements:
 *                       type: array
 *       404:
 *         description: Étudiant non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/recu-data/:id', authenticateToken, etudiantController.getRecuData);

module.exports = router;
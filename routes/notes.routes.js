const express = require('express');
const router = express.Router();
const notesController = require('../controllers/chargementNote');

// Utilisez uploadMiddleware au lieu de handleUpload
const uploadMiddleware = notesController.uploadMiddleware;

/**
 * @swagger
 * components:
 *   schemas:
 *     UploadNotesRequest:
 *       type: object
 *       required:
 *         - groupeId
 *         - matiereId
 *         - noteTypes
 *         - professeurId
 *       properties:
 *         groupeId:
 *           type: integer
 *           description: ID du groupe
 *           example: 1
 *         matiereId:
 *           type: integer
 *           description: ID de la matière
 *           example: 5
 *         noteTypes:
 *           type: string
 *           description: Types de notes (JSON string ou simple)
 *           example: '["NOTE 1", "NOTE 2", "PARTIEL"]'
 *         professeurId:
 *           type: integer
 *           description: ID du professeur
 *           example: 10
 *         fichier:
 *           type: string
 *           format: binary
 *           description: Fichier Excel (.xlsx, .xls)
 *     
 *     UploadNotesResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         details:
 *           type: object
 *           properties:
 *             fichier:
 *               type: string
 *             matiere:
 *               type: string
 *             groupe:
 *               type: string
 *             type_evaluation:
 *               type: string
 *             stats:
 *               type: object
 *               properties:
 *                 totalTraitees:
 *                   type: integer
 *                 notesInserees:
 *                   type: integer
 *                 notesMisesAJour:
 *                   type: integer
 *     
 *     TypeEvaluationResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         matiere:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *             nom:
 *               type: string
 *             type_evaluation:
 *               type: string
 *             description:
 *               type: object
 *         options_disponibles:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               value:
 *                 type: string
 *               label:
 *                 type: string
 *               description:
 *                 type: string
 *     
 *     UpdateTypeEvaluationRequest:
 *       type: object
 *       required:
 *         - type_evaluation
 *       properties:
 *         type_evaluation:
 *           type: string
 *           enum:
 *             - note_1_note_2_partiel
 *             - note_1_partiel
 *             - note_2_partiel
 *             - partiel_only
 *             - note_1_note_2
 *             - note_1_only
 *             - note_2_only
 *     
 *     CheckExistingNotesResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         notesExistantes:
 *           type: boolean
 *         count:
 *           type: integer
 *         etudiantsAvecNotes:
 *           type: integer
 *         totalEtudiants:
 *           type: integer
 *         pourcentage:
 *           type: integer
 *         message:
 *           type: string
 *         matiereInfo:
 *           type: object
 *           properties:
 *             nom:
 *               type: string
 *             type_evaluation:
 *               type: string
 */

// Route OPTIONS pour CORS preflight
router.options('/upload', (req, res) => {
  console.log('✈️ Preflight OPTIONS reçu pour /upload');
  res.header('Access-Control-Allow-Origin', process.env.FRONTEND_URL || 'http://localhost:5173');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(200).end();
});

/**
 * @swagger
 * /api/notes/test:
 *   post:
 *     summary: Test de l'API
 *     description: Route de test pour vérifier que l'API fonctionne
 *     tags: [Notes]
 *     responses:
 *       200:
 *         description: API fonctionnelle
 */
router.post('/test', notesController.testAPI);

/**
 * @swagger
 * /api/notes/test-upload:
 *   post:
 *     summary: Tester l'upload de fichier
 *     description: Route de test pour vérifier la réception de FormData
 *     tags: [Notes]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               fichier:
 *                 type: string
 *                 format: binary
 *               testData:
 *                 type: string
 *     responses:
 *       200:
 *         description: Test réussi
 */
router.post('/test-upload', uploadMiddleware, (req, res) => {
  console.log('✅ Test FormData réussi');
  console.log('📁 Fichier reçu:', req.file);
  console.log('📦 Body reçu:', req.body);
  
  res.json({
    success: true,
    message: 'FormData reçu avec succès!',
    file: req.file ? {
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size,
      path: req.file.path
    } : null,
    body: req.body,
    timestamp: new Date().toISOString()
  });
});

/**
 * @swagger
 * /api/notes/upload:
 *   post:
 *     summary: Importer des notes depuis un fichier Excel
 *     description: |
 *       Importe les notes des étudiants à partir d'un fichier Excel.
 *       - Formats supportés: .xlsx, .xls
 *       - Taille max: 10MB
 *       - Colonnes requises: CODE, NOM, PRÉNOM
 *       - Les colonnes de notes doivent correspondre aux types spécifiés
 *       - Gère la création/mise à jour des enseignements et sessions
 *       - Calcule automatiquement les moyennes selon le type d'évaluation et le type de filière
 *     tags: [Notes]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/UploadNotesRequest'
 *           example:
 *             groupeId: 1
 *             matiereId: 5
 *             noteTypes: '["NOTE 1", "NOTE 2", "PARTIEL"]'
 *             professeurId: 10
 *             fichier: (fichier binaire)
 *     responses:
 *       200:
 *         description: Importation réussie
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UploadNotesResponse'
 *       400:
 *         description: Erreur de validation (fichier invalide, données manquantes)
 *       500:
 *         description: Erreur serveur
 */
router.post('/upload', uploadMiddleware, notesController.uploadNotes);

/**
 * @swagger
 * /api/notes/template/{groupeId}/{matiereId}:
 *   get:
 *     summary: Télécharger le template Excel
 *     description: |
 *       Génère et télécharge un template Excel pré-rempli avec la liste des étudiants du groupe.
 *       - Inclut les colonnes: Code, Nom, Prénom, Note 1, Note 2, Partiel
 *       - Format: .xlsx
 *     tags: [Notes]
 *     parameters:
 *       - in: path
 *         name: groupeId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *       - in: path
 *         name: matiereId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la matière
 *     responses:
 *       200:
 *         description: Template généré avec succès
 *         content:
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Groupe ou matière non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/template/:groupeId/:matiereId', notesController.downloadTemplate);

/**
 * @swagger
 * /api/notes/groupe/{groupeId}:
 *   get:
 *     summary: Récupérer les notes d'un groupe
 *     description: Retourne toutes les notes des étudiants d'un groupe spécifique
 *     tags: [Notes]
 *     parameters:
 *       - in: path
 *         name: groupeId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *     responses:
 *       200:
 *         description: Liste des notes récupérée
 *       500:
 *         description: Erreur serveur
 */
router.get('/groupe/:groupeId', notesController.getNotesByGroupe);

/**
 * @swagger
 * /api/notes/status:
 *   get:
 *     summary: Statut des imports de notes
 *     description: Retourne des statistiques sur les imports de notes (total, dernier import, etc.)
 *     tags: [Notes]
 *     responses:
 *       200:
 *         description: Statistiques récupérées
 */
router.get('/status', notesController.getUploadStatus);

/**
 * @swagger
 * /api/notes/groupe/{groupeId}/details:
 *   get:
 *     summary: Détails d'un groupe avec ses matières
 *     description: Retourne les informations d'un groupe et la liste des matières enseignées
 *     tags: [Notes]
 *     parameters:
 *       - in: path
 *         name: groupeId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *     responses:
 *       200:
 *         description: Détails du groupe
 *       404:
 *         description: Groupe non trouvé
 */
router.get('/groupe/:groupeId/details', notesController.getGroupeDetails);

/**
 * @swagger
 * /api/notes/check-existing/{groupeId}/{matiereId}:
 *   get:
 *     summary: Vérifier l'existence de notes
 *     description: |
 *       Vérifie si des notes existent déjà pour une matière et un groupe donnés.
 *       Utile avant l'import pour informer l'utilisateur.
 *     tags: [Notes]
 *     parameters:
 *       - in: path
 *         name: groupeId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *       - in: path
 *         name: matiereId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la matière
 *       - in: query
 *         name: professeurId
 *         schema:
 *           type: integer
 *         description: ID du professeur (optionnel)
 *     responses:
 *       200:
 *         description: Vérification effectuée
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CheckExistingNotesResponse'
 */
router.get('/check-existing/:groupeId/:matiereId', notesController.checkExistingNotes);

/**
 * @swagger
 * /api/notes/type-evaluation/{matiereId}:
 *   get:
 *     summary: Obtenir le type d'évaluation d'une matière
 *     description: |
 *       Retourne le type d'évaluation actuel d'une matière avec toutes les options disponibles.
 *       Types possibles:
 *       - note_1_note_2_partiel: CC1 (20%), CC2 (20%), Examen (60%)
 *       - note_1_partiel: CC1 (40%), Examen (60%)
 *       - note_2_partiel: CC2 (40%), Examen (60%)
 *       - partiel_only: Examen seulement (100%)
 *       - note_1_note_2: Deux contrôles continus (50%/50%)
 *       - note_1_only: CC1 seulement (100%)
 *       - note_2_only: CC2 seulement (100%)
 *     tags: [Notes, Évaluation]
 *     parameters:
 *       - in: path
 *         name: matiereId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la matière
 *     responses:
 *       200:
 *         description: Type d'évaluation récupéré
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TypeEvaluationResponse'
 *       404:
 *         description: Matière non trouvée
 */
router.get('/type-evaluation/:matiereId', notesController.getTypeEvaluation);

/**
 * @swagger
 * /api/notes/type-evaluation/{matiereId}:
 *   put:
 *     summary: Mettre à jour le type d'évaluation d'une matière
 *     description: Modifie le mode de calcul des notes pour une matière
 *     tags: [Notes, Évaluation]
 *     parameters:
 *       - in: path
 *         name: matiereId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la matière
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateTypeEvaluationRequest'
 *           example:
 *             type_evaluation: "note_1_partiel"
 *     responses:
 *       200:
 *         description: Type d'évaluation mis à jour
 *       400:
 *         description: Type invalide
 *       404:
 *         description: Matière non trouvée
 */
router.put('/type-evaluation/:matiereId', notesController.updateTypeEvaluation);

/**
 * @swagger
 * /api/notes/debug-exports:
 *   get:
 *     summary: Debug - Lister les exports du contrôleur
 *     description: Route de debug pour vérifier les fonctions disponibles
 *     tags: [Debug]
 *     responses:
 *       200:
 *         description: Liste des fonctions exportées
 */
router.get('/debug-exports', (req, res) => {
  res.json({
    success: true,
    exports: Object.keys(notesController).filter(key => typeof notesController[key] === 'function'),
    uploadMiddlewareExists: typeof uploadMiddleware === 'function',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
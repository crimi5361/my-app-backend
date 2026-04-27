// routes/maquette.routes.js
const express = require('express');
const router = express.Router();
const maquetteController = require('../controllers/maquette.controller');

/**
 * @swagger
 * components:
 *   schemas:
 *     CreateMaquetteRequest:
 *       type: object
 *       required:
 *         - filiere_id
 *         - niveau_id
 *         - anneeacademique_id
 *         - parcour
 *       properties:
 *         filiere_id:
 *           type: integer
 *           description: ID de la filière
 *           example: 1
 *         niveau_id:
 *           type: integer
 *           description: ID du niveau d'étude
 *           example: 1
 *         anneeacademique_id:
 *           type: integer
 *           description: ID de l'année académique
 *           example: 1
 *         parcour:
 *           type: string
 *           description: Type de parcours
 *           enum: [Classique, Professionnel, Technique]
 *           example: "Classique"
 *     
 *     MaquetteResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         filiere_id:
 *           type: integer
 *         niveau_id:
 *           type: integer
 *         anneeacademique_id:
 *           type: integer
 *         parcour:
 *           type: string
 *         date_creation:
 *           type: string
 *           format: date-time
 *         filiere_nom:
 *           type: string
 *         filiere_sigle:
 *           type: string
 *         niveau_libelle:
 *           type: string
 *         annee_academique:
 *           type: string
 *     
 *     MaquetteDetailResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         filiere_nom:
 *           type: string
 *         filiere_sigle:
 *           type: string
 *         niveau_libelle:
 *           type: string
 *         anneeacademique_id:
 *           type: integer
 *         parcour:
 *           type: string
 *     
 *     UEResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         libelle:
 *           type: string
 *           description: Libellé de l'UE
 *         semestre_id:
 *           type: integer
 *         semestre_libelle:
 *           type: string
 *           description: Nom du semestre
 *         categorie_id:
 *           type: integer
 *         categorie_nom:
 *           type: string
 *           description: Nom de la catégorie
 *     
 *     MatiereResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         nom:
 *           type: string
 *           description: Nom de la matière
 *         coefficient:
 *           type: number
 *           format: float
 *         ue_id:
 *           type: integer
 *         ue_libelle:
 *           type: string
 *         volume_horaire_cm:
 *           type: number
 *           format: float
 *         taux_horaire_cm:
 *           type: number
 *           format: float
 *         volume_horaire_td:
 *           type: number
 *           format: float
 *         taux_horaire_td:
 *           type: number
 *           format: float
 *     
 *     AnneeAcademiqueItem:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         annee:
 *           type: string
 *           example: "2024-2025"
 *         etat:
 *           type: string
 *           enum: [active, fermee]
 */

/**
 * @swagger
 * /api/maquettes/create-maquettes:
 *   post:
 *     summary: Créer une nouvelle maquette
 *     description: |
 *       Crée une nouvelle maquette pédagogique.
 *       - Vérifie l'existence de la filière, du niveau et de l'année académique
 *       - Empêche les doublons (même combinaison filière/niveau/année/parcours)
 *       - Génère automatiquement la date de création
 *     tags: [Maquettes]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateMaquetteRequest'
 *           example:
 *             filiere_id: 1
 *             niveau_id: 1
 *             anneeacademique_id: 1
 *             parcour: "Classique"
 *     responses:
 *       201:
 *         description: Maquette créée avec succès
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   $ref: '#/components/schemas/MaquetteResponse'
 *       400:
 *         description: Données invalides ou maquette existante
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *             examples:
 *               champs_manquants:
 *                 value:
 *                   success: false
 *                   message: "Tous les champs sont obligatoires"
 *               filiere_inexistante:
 *                 value:
 *                   success: false
 *                   message: "Filière non trouvée"
 *               doublon:
 *                 value:
 *                   success: false
 *                   message: "Une maquette existe déjà pour cette combinaison"
 *       500:
 *         description: Erreur serveur
 */
router.post('/create-maquettes', maquetteController.createMaquette);

/**
 * @swagger
 * /api/maquettes:
 *   get:
 *     summary: Récupérer toutes les maquettes
 *     description: |
 *       Retourne la liste de toutes les maquettes avec leurs informations associées.
 *       Possibilité de filtrer par année académique.
 *     tags: [Maquettes]
 *     parameters:
 *       - in: query
 *         name: annee_id
 *         schema:
 *           type: integer
 *         description: Filtrer par ID de l'année académique
 *         example: 1
 *     responses:
 *       200:
 *         description: Liste des maquettes récupérée
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MaquetteResponse'
 *             example:
 *               - id: 1
 *                 filiere_nom: "Informatique"
 *                 filiere_sigle: "INF"
 *                 niveau_libelle: "Licence 1"
 *                 annee_academique: "2024-2025"
 *                 parcour: "Classique"
 *                 date_creation: "2024-10-01T10:00:00Z"
 *       500:
 *         description: Erreur serveur
 */
router.get('/', maquetteController.getAllMaquettes);

/**
 * @swagger
 * /api/maquettes/annees-accademique:
 *   get:
 *     summary: Récupérer toutes les années académiques
 *     description: Retourne la liste de toutes les années académiques disponibles
 *     tags: [Maquettes]
 *     responses:
 *       200:
 *         description: Liste des années académiques
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AnneeAcademiqueItem'
 *             example:
 *               - id: 1
 *                 annee: "2024-2025"
 *                 etat: "active"
 *               - id: 2
 *                 annee: "2023-2024"
 *                 etat: "fermee"
 *       404:
 *         description: Aucune année académique trouvée
 *       500:
 *         description: Erreur serveur
 */
router.get('/annees-accademique', maquetteController.getAllAnnee);

/**
 * @swagger
 * /api/maquettes/maquettes/{id}:
 *   get:
 *     summary: Récupérer les détails d'une maquette
 *     description: Retourne les informations détaillées d'une maquette spécifique (filière, niveau, parcours)
 *     tags: [Maquettes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la maquette
 *         example: 1
 *     responses:
 *       200:
 *         description: Détails de la maquette
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/MaquetteDetailResponse'
 *             example:
 *               id: 1
 *               filiere_nom: "Informatique"
 *               filiere_sigle: "INF"
 *               niveau_libelle: "Licence 1"
 *               anneeacademique_id: 1
 *               parcour: "Classique"
 *       404:
 *         description: Maquette non trouvée
 *       500:
 *         description: Erreur serveur
 */
router.get('/maquettes/:id', maquetteController.getMaquetteDetail);

/**
 * @swagger
 * /api/maquettes/maquettes/{id}/ues:
 *   get:
 *     summary: Récupérer les UE d'une maquette
 *     description: |
 *       Retourne toutes les Unités d'Enseignement (UE) associées à une maquette.
 *       - Inclut les informations du semestre et de la catégorie
 *       - Trié par semestre puis par libellé d'UE
 *     tags: [Maquettes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la maquette
 *         example: 1
 *     responses:
 *       200:
 *         description: Liste des UE
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/UEResponse'
 *             example:
 *               - id: 1
 *                 libelle: "Programmation"
 *                 semestre_id: 1
 *                 semestre_libelle: "Semestre 1"
 *                 categorie_id: 1
 *                 categorie_nom: "Fondamentale"
 *               - id: 2
 *                 libelle: "Mathématiques"
 *                 semestre_id: 1
 *                 semestre_libelle: "Semestre 1"
 *                 categorie_id: 1
 *                 categorie_nom: "Fondamentale"
 *       500:
 *         description: Erreur serveur
 */
router.get('/maquettes/:id/ues', maquetteController.getMaquetteUes);

/**
 * @swagger
 * /api/maquettes/maquettes/{id}/matieres:
 *   get:
 *     summary: Récupérer les matières d'une maquette
 *     description: |
 *       Retourne toutes les matières associées à une maquette.
 *       - Inclut les coefficients et volumes horaires
 *       - Inclut l'UE parente
 *       - Trié par UE puis par nom de matière
 *     tags: [Maquettes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la maquette
 *         example: 1
 *     responses:
 *       200:
 *         description: Liste des matières
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MatiereResponse'
 *             example:
 *               - id: 1
 *                 nom: "Algorithmique"
 *                 coefficient: 3
 *                 ue_id: 1
 *                 ue_libelle: "Programmation"
 *                 volume_horaire_cm: 30
 *                 taux_horaire_cm: 1.5
 *                 volume_horaire_td: 20
 *                 taux_horaire_td: 1.2
 *               - id: 2
 *                 nom: "Java"
 *                 coefficient: 4
 *                 ue_id: 1
 *                 ue_libelle: "Programmation"
 *                 volume_horaire_cm: 25
 *                 taux_horaire_cm: 1.5
 *                 volume_horaire_td: 30
 *                 taux_horaire_td: 1.2
 *       500:
 *         description: Erreur serveur
 */
router.get('/maquettes/:id/matieres', maquetteController.getMaquetteMatieres);

module.exports = router;
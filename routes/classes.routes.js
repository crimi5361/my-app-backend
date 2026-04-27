const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const classesController = require('../controllers/classes.controller');

/**
 * @swagger
 * components:
 *   schemas:
 *     ClasseListeItem:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: ID de la classe
 *         nom:
 *           type: string
 *           description: Nom de la classe
 *           example: "Informatique L1"
 *         description:
 *           type: string
 *           description: Description de la classe
 *         annee_academique:
 *           type: string
 *           description: Année académique
 *           example: "2024-2025"
 *         annee_etat:
 *           type: string
 *           description: État de l'année académique
 *           enum: [active, fermee]
 *         nombre_groupes:
 *           type: integer
 *           description: Nombre de groupes dans la classe
 *         effectif_total:
 *           type: integer
 *           description: Nombre total d'étudiants dans la classe
 *         filiere:
 *           type: string
 *           description: Filière de la classe
 *         niveau:
 *           type: string
 *           description: Niveau d'étude
 *         departement:
 *           type: string
 *           description: Département
 *     
 *     GroupeItem:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         nom:
 *           type: string
 *         capacite_max:
 *           type: integer
 *         effectif:
 *           type: integer
 *         taux_remplissage:
 *           type: number
 *           format: float
 *     
 *     DetailClasseResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         nom:
 *           type: string
 *         description:
 *           type: string
 *         annee_academique:
 *           type: string
 *         annee_etat:
 *           type: string
 *         filiere:
 *           type: string
 *         niveau:
 *           type: string
 *         effectif_total:
 *           type: integer
 *         groupes:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/GroupeItem'
 *     
 *     DetailGroupeResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         nom:
 *           type: string
 *         capacite_max:
 *           type: integer
 *         effectif:
 *           type: integer
 *         taux_remplissage:
 *           type: number
 *         classe_nom:
 *           type: string
 *         etudiants:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: integer
 *               matricule_iipea:
 *                 type: string
 *               nom:
 *                 type: string
 *               prenoms:
 *                 type: string
 *               telephone:
 *                 type: string
 *               email:
 *                 type: string
 *               photo_url:
 *                 type: string
 *               filiere:
 *                 type: string
 *               niveau:
 *                 type: string
 *               cursus:
 *                 type: string
 *               statut_scolaire:
 *                 type: string
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
 *     
 *     ClassesAvecGroupesResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         nom:
 *           type: string
 *         description:
 *           type: string
 *         annee_academique:
 *           type: string
 *         annee_etat:
 *           type: string
 *         effectif_total:
 *           type: integer
 *         groupes:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/GroupeItem'
 */

/**
 * @swagger
 * /api/classes/classes/liste:
 *   get:
 *     summary: Récupérer la liste des classes
 *     description: |
 *       Retourne la liste de toutes les classes avec leurs statistiques :
 *       - Nombre de groupes par classe
 *       - Effectif total d'étudiants
 *       - Filière et niveau associés
 *       - Année académique
 *     tags: [Classes & Groupes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: annee_id
 *         schema:
 *           type: integer
 *         description: Filtrer par année académique (optionnel)
 *         example: 1
 *     responses:
 *       200:
 *         description: Liste des classes récupérée avec succès
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ClasseListeItem'
 *       500:
 *         description: Erreur serveur
 */
router.get('/classes/liste', authenticateToken, classesController.getListeClasses);

/**
 * @swagger
 * /api/classes/classe/{id}:
 *   get:
 *     summary: Récupérer les détails d'une classe
 *     description: |
 *       Retourne les informations détaillées d'une classe spécifique :
 *       - Informations générales de la classe
 *       - Liste de tous les groupes avec leurs effectifs
 *       - Taux de remplissage de chaque groupe
 *     tags: [Classes & Groupes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la classe
 *         example: 1
 *     responses:
 *       200:
 *         description: Détails de la classe récupérés
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/DetailClasseResponse'
 *             example:
 *               success: true
 *               data:
 *                 id: 1
 *                 nom: "Informatique L1"
 *                 description: "Classe de première année Informatique"
 *                 annee_academique: "2024-2025"
 *                 annee_etat: "active"
 *                 filiere: "Informatique"
 *                 niveau: "L1"
 *                 effectif_total: 120
 *                 groupes:
 *                   - id: 1
 *                     nom: "Groupe A"
 *                     capacite_max: 40
 *                     effectif: 38
 *                     taux_remplissage: 95
 *                   - id: 2
 *                     nom: "Groupe B"
 *                     capacite_max: 40
 *                     effectif: 42
 *                     taux_remplissage: 105
 *       404:
 *         description: Classe non trouvée
 *       500:
 *         description: Erreur serveur
 */
router.get('/classe/:id', authenticateToken, classesController.getDetailClasse);

/**
 * @swagger
 * /api/classes/groupe/{id}:
 *   get:
 *     summary: Récupérer les détails d'un groupe
 *     description: |
 *       Retourne les informations détaillées d'un groupe spécifique :
 *       - Informations du groupe (nom, capacité, taux de remplissage)
 *       - Classe parente
 *       - Liste de tous les étudiants du groupe avec leurs informations
 *     tags: [Classes & Groupes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *         example: 1
 *     responses:
 *       200:
 *         description: Détails du groupe récupérés
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/DetailGroupeResponse'
 *             example:
 *               success: true
 *               data:
 *                 id: 1
 *                 nom: "Groupe A"
 *                 capacite_max: 40
 *                 effectif: 38
 *                 taux_remplissage: 95
 *                 classe_nom: "Informatique L1"
 *                 etudiants:
 *                   - id: 123
 *                     matricule_iipea: "24INF001"
 *                     nom: "DIALLO"
 *                     prenoms: "Mamadou"
 *                     telephone: "+221771234567"
 *                     email: "mamadou.diallo@iipea.com"
 *                     filiere: "Informatique"
 *                     niveau: "L1"
 *                     cursus: "Classique"
 *                     statut_scolaire: "Régulier"
 *       404:
 *         description: Groupe non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/groupe/:id', authenticateToken, classesController.getDetailGroupe);

/**
 * @swagger
 * /api/classes/groupe/{id}/info:
 *   get:
 *     summary: Récupérer les informations basiques d'un groupe
 *     description: Route publique (sans authentification) pour obtenir les informations simples d'un groupe (id et nom)
 *     tags: [Classes & Groupes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *         example: 1
 *     responses:
 *       200:
 *         description: Informations du groupe récupérées
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: integer
 *                 nom:
 *                   type: string
 *             example:
 *               id: 1
 *               nom: "Groupe A"
 *       404:
 *         description: Groupe non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/groupe/:id/info', classesController.getGroupeSimpleInfo);

/**
 * @swagger
 * /api/classes/annees-academiques:
 *   get:
 *     summary: Récupérer la liste des années académiques
 *     description: Retourne toutes les années académiques disponibles (utilisé pour les filtres)
 *     tags: [Classes & Groupes]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des années académiques
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/AnneeAcademiqueItem'
 *             example:
 *               success: true
 *               data:
 *                 - id: 1
 *                   annee: "2024-2025"
 *                   etat: "active"
 *                 - id: 2
 *                   annee: "2023-2024"
 *                   etat: "fermee"
 *       500:
 *         description: Erreur serveur
 */
router.get('/annees-academiques', authenticateToken, classesController.getAnneesAcademiques);

/**
 * @swagger
 * /api/classes/classes:
 *   get:
 *     summary: Récupérer les classes avec leurs groupes (ancienne route)
 *     description: |
 *       Route conservée pour compatibilité.
 *       Retourne la structure complète des classes et leurs groupes.
 *     tags: [Classes & Groupes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: annee_id
 *         schema:
 *           type: integer
 *         description: Filtrer par année académique
 *     responses:
 *       200:
 *         description: Classes avec groupes récupérées
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ClassesAvecGroupesResponse'
 *       500:
 *         description: Erreur serveur
 */
router.get('/classes', authenticateToken, classesController.getClassesAvecGroupes);

module.exports = router;
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const priseEnChargeController = require('../controllers/priseEnCharge.controller'); 

/**
 * @swagger
 * components:
 *   schemas:
 *     PECActiveResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: true
 *         data:
 *           type: object
 *           nullable: true
 *           properties:
 *             id:
 *               type: integer
 *             etudiant_id:
 *               type: integer
 *             type_pec:
 *               type: string
 *               enum: [Boursier, Convention, Handicap, Merite]
 *             pourcentage_reduction:
 *               type: number
 *               format: float
 *             montant_reduction:
 *               type: number
 *               format: float
 *             reference:
 *               type: string
 *             statut:
 *               type: string
 *               enum: [en_attente, valide, refuse]
 *             date_demande:
 *               type: string
 *               format: date-time
 *             date_validation:
 *               type: string
 *               format: date-time
 *               nullable: true
 *             valide_par:
 *               type: integer
 *               nullable: true
 *             motif_refus:
 *               type: string
 *               nullable: true
 *     
 *     PECEnAttenteItem:
 *       type: object
 *       properties:
 *         pec_id:
 *           type: integer
 *         type_pec:
 *           type: string
 *         pourcentage_reduction:
 *           type: number
 *         reference:
 *           type: string
 *         date_demande:
 *           type: string
 *           format: date-time
 *         statut:
 *           type: string
 *         etudiant_id:
 *           type: integer
 *         matricule_iipea:
 *           type: string
 *         nom:
 *           type: string
 *         prenoms:
 *           type: string
 *         telephone:
 *           type: string
 *         email:
 *           type: string
 *         filiere:
 *           type: string
 *         filiere_sigle:
 *           type: string
 *         niveau:
 *           type: string
 *         montant_scolarite:
 *           type: number
 *         scolarite_verse:
 *           type: number
 *         scolarite_restante:
 *           type: number
 *         statut_etudiant:
 *           type: string
 *         reduction_calculee:
 *           type: number
 *     
 *     PECTraiteeItem:
 *       type: object
 *       properties:
 *         pec_id:
 *           type: integer
 *         type_pec:
 *           type: string
 *         pourcentage_reduction:
 *           type: number
 *         montant_reduction:
 *           type: number
 *         reference:
 *           type: string
 *         date_demande:
 *           type: string
 *           format: date-time
 *         date_validation:
 *           type: string
 *           format: date-time
 *         statut:
 *           type: string
 *           enum: [valide, refuse]
 *         motif_refus:
 *           type: string
 *           nullable: true
 *         etudiant_id:
 *           type: integer
 *         matricule_iipea:
 *           type: string
 *         nom:
 *           type: string
 *         prenoms:
 *           type: string
 *         telephone:
 *           type: string
 *         email:
 *           type: string
 *         filiere:
 *           type: string
 *         filiere_sigle:
 *           type: string
 *         niveau:
 *           type: string
 *         montant_scolarite:
 *           type: number
 *         scolarite_verse:
 *           type: number
 *         scolarite_restante:
 *           type: number
 *         statut_etudiant:
 *           type: string
 *         reduction_calculee:
 *           type: number
 *         total_verse_virtuel:
 *           type: number
 *         restant_virtuel:
 *           type: number
 *     
 *     PECStatsItem:
 *       type: object
 *       properties:
 *         total_pec_traitees:
 *           type: integer
 *         total_validees:
 *           type: integer
 *         total_refusees:
 *           type: integer
 *         total_reduction:
 *           type: number
 *         moyenne_reduction:
 *           type: number
 *         type_pec:
 *           type: string
 *         count_type:
 *           type: integer
 */

/**
 * @swagger
 * /api/priseEnCharge/etudiant/{id}/active:
 *   get:
 *     summary: Récupérer la PEC active d'un étudiant
 *     description: Retourne la prise en charge active (validée) d'un étudiant spécifique
 *     tags: [Prise en charge]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'étudiant
 *         example: 123
 *     responses:
 *       200:
 *         description: PEC récupérée avec succès
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PECActiveResponse'
 *             examples:
 *               avec_pec:
 *                 value:
 *                   success: true
 *                   data:
 *                     id: 1
 *                     etudiant_id: 123
 *                     type_pec: "Boursier"
 *                     pourcentage_reduction: 50
 *                     montant_reduction: 250000
 *                     statut: "valide"
 *               sans_pec:
 *                 value:
 *                   success: true
 *                   data: null
 *       500:
 *         description: Erreur serveur
 */
router.get('/etudiant/:id/active', authenticateToken, priseEnChargeController.getActivePECByEtudiant);

/**
 * @swagger
 * /api/priseEnCharge/pec-en-attente:
 *   get:
 *     summary: Récupérer les demandes de PEC en attente
 *     description: |
 *       Liste toutes les demandes de prise en charge en attente de validation.
 *       - Filtré automatiquement par département de l'utilisateur connecté
 *       - Inclut les informations complètes de l'étudiant
 *       - Trié par date de demande décroissante
 *     tags: [Prise en charge]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: anneeAcademiqueId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'année académique
 *         example: 1
 *     responses:
 *       200:
 *         description: Liste des PEC en attente
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
 *                     $ref: '#/components/schemas/PECEnAttenteItem'
 *             example:
 *               success: true
 *               data:
 *                 - pec_id: 5
 *                   type_pec: "Boursier"
 *                   pourcentage_reduction: 50
 *                   reference: "B2024-001"
 *                   date_demande: "2024-10-15T10:30:00Z"
 *                   etudiant_id: 123
 *                   nom: "DIALLO"
 *                   prenoms: "Mamadou"
 *                   filiere: "Informatique"
 *                   niveau: "L1"
 *                   montant_scolarite: 500000
 *                   reduction_calculee: 250000
 *       400:
 *         description: Année académique manquante
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *             example:
 *               success: false
 *               message: "L'ID de l'année académique est requis"
 *       500:
 *         description: Erreur serveur
 */
router.get('/pec-en-attente', authenticateToken, priseEnChargeController.getPECEnAttente);

/**
 * @swagger
 * /api/priseEnCharge/traitees:
 *   get:
 *     summary: Récupérer les PEC traitées (validées et refusées)
 *     description: |
 *       Liste toutes les prises en charge qui ont été traitées (validées ou refusées).
 *       - Filtré par département et année académique
 *       - Inclut les informations de validation (date, motif de refus)
 *       - Calcule les montants virtuels après application de la réduction
 *       - Trié par date de validation décroissante
 *     tags: [Prise en charge]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: anneeAcademiqueId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'année académique
 *         example: 1
 *     responses:
 *       200:
 *         description: Liste des PEC traitées
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
 *                     $ref: '#/components/schemas/PECTraiteeItem'
 *             example:
 *               success: true
 *               data:
 *                 - pec_id: 3
 *                   type_pec: "Boursier"
 *                   pourcentage_reduction: 50
 *                   montant_reduction: 250000
 *                   date_demande: "2024-10-01T09:00:00Z"
 *                   date_validation: "2024-10-05T14:30:00Z"
 *                   statut: "valide"
 *                   nom: "DIALLO"
 *                   prenoms: "Mamadou"
 *                   montant_scolarite: 500000
 *                   scolarite_verse: 100000
 *                   total_verse_virtuel: 350000
 *                   restant_virtuel: 150000
 *       400:
 *         description: Année académique manquante
 *       500:
 *         description: Erreur serveur
 */
router.get('/traitees', authenticateToken, priseEnChargeController.getPECTraitees);

/**
 * @swagger
 * /api/priseEnCharge/traitees/stats:
 *   get:
 *     summary: Obtenir les statistiques des PEC traitées
 *     description: |
 *       Retourne des statistiques détaillées sur les prises en charge traitées :
 *       - Nombre total de PEC traitées
 *       - Nombre de validations et refus
 *       - Montant total des réductions accordées
 *       - Moyenne des réductions
 *       - Détail par type de PEC
 *     tags: [Prise en charge]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: anneeAcademiqueId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'année académique
 *         example: 1
 *     responses:
 *       200:
 *         description: Statistiques récupérées avec succès
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
 *                     $ref: '#/components/schemas/PECStatsItem'
 *             example:
 *               success: true
 *               data:
 *                 - type_pec: "Boursier"
 *                   total_pec_traitees: 25
 *                   total_validees: 20
 *                   total_refusees: 5
 *                   total_reduction: 5000000
 *                   moyenne_reduction: 250000
 *                   count_type: 25
 *                 - type_pec: "Merite"
 *                   total_pec_traitees: 10
 *                   total_validees: 8
 *                   total_refusees: 2
 *                   total_reduction: 1000000
 *                   moyenne_reduction: 125000
 *                   count_type: 10
 *       400:
 *         description: Année académique manquante
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *             example:
 *               success: false
 *               message: "L'ID de l'année académique est requis"
 *       500:
 *         description: Erreur serveur
 */
router.get('/traitees/stats', authenticateToken, priseEnChargeController.getStatsPECtraitees);

module.exports = router;
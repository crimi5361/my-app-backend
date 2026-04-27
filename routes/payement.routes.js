const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const paiementController = require('../controllers/paiyement.controller');

/**
 * @swagger
 * components:
 *   schemas:
 *     PaiementRequest:
 *       type: object
 *       required:
 *         - etudiant_id
 *         - montant
 *         - methode
 *       properties:
 *         etudiant_id:
 *           type: integer
 *           description: ID de l'étudiant
 *           example: 123
 *         montant:
 *           type: number
 *           format: float
 *           description: Montant du paiement
 *           example: 250000
 *         methode:
 *           type: string
 *           enum: [OM, Wave, Carte, Especes]
 *           description: Mode de paiement
 *           example: "OM"
 *         veut_kit_ecole:
 *           type: boolean
 *           description: Souhaite payer le kit école (uniquement premier paiement)
 *           default: false
 *         demande_pec:
 *           type: boolean
 *           description: Souhaite faire une demande de prise en charge
 *           default: false
 *         type_pec:
 *           type: string
 *           enum: [Boursier, Convention, Handicap, Merite]
 *           description: Type de prise en charge (requis si demande_pec=true)
 *         pourcentage_reduction:
 *           type: number
 *           format: float
 *           description: Pourcentage de réduction (requis si demande_pec=true)
 *           minimum: 1
 *           maximum: 100
 *         reference_pec:
 *           type: string
 *           description: Référence de la prise en charge (optionnel)
 *     
 *     PaiementResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         data:
 *           type: object
 *           properties:
 *             paiement_id:
 *               type: integer
 *             recu_id:
 *               type: integer
 *             numero_recu:
 *               type: string
 *             scolarite_verse:
 *               type: number
 *             scolarite_restante:
 *               type: number
 *             statut_etudiant:
 *               type: string
 *               enum: [NON_SOLDE, SOLDE]
 *             is_premier_paiement:
 *               type: boolean
 *             kit_ajoute:
 *               type: boolean
 *             demande_pec_envoyee:
 *               type: boolean
 *             reduction_appliquee:
 *               type: number
 *             total_scolarite:
 *               type: number
 *             type_filiere:
 *               type: string
 *     
 *     PECRequest:
 *       type: object
 *       required:
 *         - etudiant_id
 *         - type_pec
 *         - pourcentage_reduction
 *       properties:
 *         etudiant_id:
 *           type: integer
 *           description: ID de l'étudiant
 *         type_pec:
 *           type: string
 *           enum: [Boursier, Convention, Handicap, Merite]
 *           description: Type de prise en charge
 *         pourcentage_reduction:
 *           type: number
 *           format: float
 *           description: Pourcentage de réduction (1-100)
 *           minimum: 1
 *           maximum: 100
 *         reference_pec:
 *           type: string
 *           description: Référence de la prise en charge
 *     
 *     PECValidationRequest:
 *       type: object
 *       required:
 *         - pec_id
 *         - action
 *       properties:
 *         pec_id:
 *           type: integer
 *           description: ID de la prise en charge
 *         action:
 *           type: string
 *           enum: [valider, refuser]
 *           description: Action à effectuer
 *         motif_refus:
 *           type: string
 *           description: Motif du refus (requis si action=refuser)
 *     
 *     PaiementListResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         data:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               montant:
 *                 type: number
 *               date_paiement:
 *                 type: string
 *                 format: date-time
 *               methode:
 *                 type: string
 *               numero_recu:
 *                 type: string
 *               date_emission:
 *                 type: string
 *                 format: date-time
 *               emetteur:
 *                 type: string
 *               nom_etudiant:
 *                 type: string
 *               prenoms_etudiant:
 *                 type: string
 *               nom_departement:
 *                 type: string
 *               nom_utilisateur_effectue_par:
 *                 type: string
 *               annee_academique:
 *                 type: string
 *         total:
 *           type: integer
 *         page:
 *           type: integer
 *         limit:
 *           type: integer
 *         total_pages:
 *           type: integer
 */

/**
 * @swagger
 * /api/paiements:
 *   post:
 *     summary: Créer un nouveau paiement
 *     description: |
 *       Enregistre un paiement pour un étudiant.
 *       - Génère automatiquement un reçu
 *       - Met à jour la scolarité
 *       - Si premier paiement : crée le kit et assigne l'étudiant à un groupe
 *       - Peut faire une demande de PEC simultanément
 *     tags: [Paiements]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PaiementRequest'
 *     responses:
 *       201:
 *         description: Paiement enregistré avec succès
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaiementResponse'
 *       400:
 *         description: Données manquantes ou invalides
 *       401:
 *         description: Authentification requise
 *       500:
 *         description: Erreur serveur
 */
router.post('/', authenticateToken, paiementController.createPaiement);

/**
 * @swagger
 * /api/paiements/Allpayement:
 *   get:
 *     summary: Récupérer tous les paiements par département
 *     description: |
 *       Liste tous les paiements avec pagination et filtres.
 *       Retourne les détails des paiements, des reçus et des étudiants.
 *     tags: [Paiements]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: departement_id
 *         schema:
 *           type: integer
 *         description: ID du département (défaut = département de l'utilisateur)
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
 *           maximum: 100
 *         description: Éléments par page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Recherche (nom étudiant, numéro reçu)
 *       - in: query
 *         name: filiere
 *         schema:
 *           type: string
 *         description: Filtrer par filière
 *       - in: query
 *         name: niveau
 *         schema:
 *           type: string
 *         description: Filtrer par niveau
 *       - in: query
 *         name: date_debut
 *         schema:
 *           type: string
 *           format: date
 *         description: Date de début (YYYY-MM-DD)
 *       - in: query
 *         name: date_fin
 *         schema:
 *           type: string
 *           format: date
 *         description: Date de fin (YYYY-MM-DD)
 *     responses:
 *       200:
 *         description: Liste des paiements récupérée
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaiementListResponse'
 *       400:
 *         description: Paramètres manquants
 *       404:
 *         description: Année académique non trouvée
 *       500:
 *         description: Erreur serveur
 */
router.get('/Allpayement', authenticateToken, paiementController.getPaiementsByDepartement);

/**
 * @swagger
 * /api/paiements/etudiant/{id}/count:
 *   get:
 *     summary: Compter les paiements d'un étudiant
 *     description: Retourne le nombre total de paiements effectués par un étudiant
 *     tags: [Paiements]
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
 *         description: Comptage réussi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *       500:
 *         description: Erreur serveur
 */
router.get('/etudiant/:id/count', authenticateToken, paiementController.getPaiementCountByEtudiant);

/**
 * @swagger
 * /api/paiements/valider-pec:
 *   post:
 *     summary: Valider ou refuser une demande de prise en charge
 *     description: |
 *       Permet à un administrateur de valider ou refuser une demande de PEC.
 *       - Validation : applique la réduction sur la scolarité
 *       - Refus : rejette la demande avec motif
 *     tags: [Paiements, Prise en charge]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PECValidationRequest'
 *           examples:
 *             validation:
 *               summary: Valider une PEC
 *               value:
 *                 pec_id: 1
 *                 action: "valider"
 *             refus:
 *               summary: Refuser une PEC
 *               value:
 *                 pec_id: 1
 *                 action: "refuser"
 *                 motif_refus: "Dossier incomplet"
 *     responses:
 *       200:
 *         description: Action effectuée avec succès
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
 *                   type: object
 *                   properties:
 *                     montant_reduction:
 *                       type: number
 *                     nouveau_montant_restant:
 *                       type: number
 *                     nouveau_statut:
 *                       type: string
 *       400:
 *         description: Données manquantes ou invalides
 *       401:
 *         description: Authentification requise
 *       500:
 *         description: Erreur serveur
 */
router.post('/valider-pec', authenticateToken, paiementController.validerPEC);

/**
 * @swagger
 * /api/paiements/demande-pec:
 *   post:
 *     summary: Faire une demande de prise en charge sans paiement
 *     description: |
 *       Permet à un étudiant de faire une demande de PEC indépendamment d'un paiement.
 *       La demande sera en attente jusqu'à validation par un administrateur.
 *     tags: [Paiements, Prise en charge]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PECRequest'
 *     responses:
 *       201:
 *         description: Demande envoyée avec succès
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
 *                   type: object
 *                   properties:
 *                     pec_id:
 *                       type: integer
 *                     date_demande:
 *                       type: string
 *                       format: date-time
 *                     montant_reduction:
 *                       type: number
 *                     statut:
 *                       type: string
 *       400:
 *         description: Données manquantes ou invalides
 *       401:
 *         description: Authentification requise
 *       409:
 *         description: Une demande existe déjà
 *       500:
 *         description: Erreur serveur
 */
router.post('/demande-pec', authenticateToken, paiementController.demanderPECSeule);

module.exports = router;
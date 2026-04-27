const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const pvController = require('../controllers/PV.controller');

/**
 * @swagger
 * components:
 *   schemas:
 *     PVGroupeResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         groupe:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *             nom:
 *               type: string
 *             annee_academique:
 *               type: string
 *         maquette:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *             filiere:
 *               type: string
 *             sigle:
 *               type: string
 *             parcour:
 *               type: string
 *         type_filiere:
 *           type: string
 *         type_traitement:
 *           type: string
 *           enum: [universitaire, professionnel]
 *         etudiants:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               etudiant_id:
 *                 type: integer
 *               matricule_iipea:
 *                 type: string
 *               nom:
 *                 type: string
 *               prenoms:
 *                 type: string
 *               moyenne_generale:
 *                 type: number
 *               credits_valides:
 *                 type: integer
 *               credits_total:
 *                 type: integer
 *               decision:
 *                 type: string
 *                 enum: [ADMIS, AJOURNÉ]
 *               ues:
 *                 type: array
 *               scolarite_soldee:
 *                 type: boolean
 *         statistiques:
 *           type: object
 *           properties:
 *             total_etudiants:
 *               type: integer
 *             total_admis:
 *               type: integer
 *             total_ajournes:
 *               type: integer
 *     
 *     PVEtudiantResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         etudiant:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *             matricule_iipea:
 *               type: string
 *             nom:
 *               type: string
 *             prenoms:
 *               type: string
 *         moyenne_generale:
 *           type: number
 *         credits_valides:
 *           type: integer
 *         credits_total:
 *           type: integer
 *         decision:
 *           type: string
 *         ues:
 *           type: array
 *         ecue_a_reprendre:
 *           type: array
 *     
 *     BulletinResponse:
 *       type: object
 *       properties:
 *         etudiant:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *             matricule_iipea:
 *               type: string
 *             matricule_mesrs:
 *               type: string
 *             nom:
 *               type: string
 *             prenoms:
 *               type: string
 *             date_naissance:
 *               type: string
 *             lieu_naissance:
 *               type: string
 *             genre:
 *               type: string
 *             nationalite:
 *               type: string
 *             niveau_id:
 *               type: string
 *             moyenne_generale:
 *               type: number
 *             credits_valides:
 *               type: integer
 *             credits_total:
 *               type: integer
 *             decision:
 *               type: string
 *             moyenne_s1:
 *               type: number
 *             credits_s1:
 *               type: integer
 *             moyenne_s2:
 *               type: number
 *             credits_s2:
 *               type: integer
 *         groupe:
 *           type: object
 *         maquette:
 *           type: object
 */

/**
 * @swagger
 * /api/PV/api/groupe/{groupeId}:
 *   get:
 *     summary: Générer le PV complet d'un groupe
 *     description: |
 *       Génère le Procès-Verbal complet pour tous les étudiants d'un groupe.
 *       - Calcule les moyennes par UE et générale
 *       - Calcule les crédits validés
 *       - Détermine les décisions (ADMIS/AJOURNÉ)
 *       - Identifie les ECUE à reprendre
 *       - S'adapte au type de filière (Universitaire/Professionnel)
 *       - Applique l'harmonisation des notes pour les filières universitaires
 *     tags: [PV & Bulletins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupeId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *         example: 1
 *     responses:
 *       200:
 *         description: PV généré avec succès
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PVGroupeResponse'
 *       404:
 *         description: Groupe non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/api/groupe/:groupeId', authenticateToken, pvController.genererPVByGroupe);

/**
 * @swagger
 * /api/PV/api/groupe/{groupeId}/semestre/{semestreId}:
 *   get:
 *     summary: Générer le PV d'un groupe pour un semestre spécifique
 *     description: |
 *       Génère le PV pour un groupe, limité à un semestre spécifique (S1 ou S2).
 *       Utile pour les PV semestriels.
 *     tags: [PV & Bulletins]
 *     parameters:
 *       - in: path
 *         name: groupeId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *       - in: path
 *         name: semestreId
 *         required: true
 *         schema:
 *           type: integer
 *           enum: [1, 2]
 *         description: ID du semestre (1 ou 2)
 *     responses:
 *       200:
 *         description: PV semestriel généré
 *       404:
 *         description: Groupe non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/api/groupe/:groupeId/semestre/:semestreId', pvController.genererPVBySemestre);

/**
 * @swagger
 * /api/PV/api/etudiant/{etudiantId}:
 *   get:
 *     summary: Générer le PV d'un étudiant
 *     description: |
 *       Génère le PV individuel pour un étudiant spécifique.
 *       - Détail par UE et par matière
 *       - Moyennes et crédits
 *       - Liste des ECUE à reprendre
 *     tags: [PV & Bulletins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: etudiantId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'étudiant
 *     responses:
 *       200:
 *         description: PV étudiant généré
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PVEtudiantResponse'
 *       404:
 *         description: Étudiant non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/api/etudiant/:etudiantId', authenticateToken, pvController.genererPVByEtudiant);

/**
 * @swagger
 * /api/PV/vue/groupe/{groupeId}/semestre/{semestreId}:
 *   get:
 *     summary: Afficher la page HTML du PV
 *     description: |
 *       Affiche une page HTML formatée du PV pour un groupe et semestre donnés.
 *       Utilise le moteur de template EJS.
 *       Accessible via navigateur.
 *     tags: [PV & Bulletins - Vue]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupeId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *       - in: path
 *         name: semestreId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du semestre
 *     responses:
 *       200:
 *         description: Page HTML du PV
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       404:
 *         description: Groupe non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/vue/groupe/:groupeId/semestre/:semestreId', authenticateToken, pvController.afficherPVPage);

/**
 * @swagger
 * /api/PV/vue/etudiant/{matricule}/bulletin:
 *   get:
 *     summary: Afficher le bulletin d'un étudiant
 *     description: |
 *       Affiche le bulletin scolaire complet d'un étudiant.
 *       - Utilise le matricule_iipea comme identifiant
 *       - Inclut les résultats par semestre (S1 et S2)
 *       - Détail des UE et matières avec notes
 *       - Format HTML pour impression
 *     tags: [PV & Bulletins - Vue]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: matricule
 *         required: true
 *         schema:
 *           type: string
 *         description: Matricule IIPEA de l'étudiant
 *         example: "24INF001"
 *       - in: path
 *         name: semestreId
 *         required: false
 *         schema:
 *           type: integer
 *         description: ID du semestre (optionnel, bulletin annuel par défaut)
 *     responses:
 *       200:
 *         description: Bulletin HTML
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       404:
 *         description: Étudiant non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/vue/etudiant/:matricule/bulletin', authenticateToken, pvController.afficherBulletinByMatricule);

/**
 * @swagger
 * /api/PV/vue/etudiant/{matricule}/bulletin/semestre/{semestreId}:
 *   get:
 *     summary: Afficher le bulletin d'un étudiant pour un semestre
 *     description: |
 *       Affiche le bulletin scolaire d'un étudiant pour un semestre spécifique.
 *       - Semestre 1 ou Semestre 2
 *     tags: [PV & Bulletins - Vue]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: matricule
 *         required: true
 *         schema:
 *           type: string
 *         description: Matricule IIPEA de l'étudiant
 *       - in: path
 *         name: semestreId
 *         required: true
 *         schema:
 *           type: integer
 *           enum: [1, 2]
 *         description: ID du semestre (1 ou 2)
 *     responses:
 *       200:
 *         description: Bulletin semestriel HTML
 *       404:
 *         description: Étudiant non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/vue/etudiant/:matricule/bulletin/semestre/:semestreId', authenticateToken, pvController.afficherBulletinByMatricule);

/**
 * @swagger
 * /api/PV/vue/groupe/{groupeId}/bulletins:
 *   get:
 *     summary: Afficher les bulletins multiples d'un groupe
 *     description: |
 *       Affiche les bulletins de tous les étudiants d'un groupe sur une seule page.
 *       - Idéal pour l'impression massive
 *       - Format condensé par étudiant
 *       - Inclut les résultats semestriels et annuels
 *       - Adapté au type de filière
 *     tags: [PV & Bulletins - Vue]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupeId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *     responses:
 *       200:
 *         description: Page des bulletins multiples
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       404:
 *         description: Groupe non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/vue/groupe/:groupeId/bulletins', authenticateToken, pvController.afficherBulletinsMultiples);

/**
 * @swagger
 * /api/PV/vue/groupe/{groupeId}/bulletins/semestre/{semestreId}:
 *   get:
 *     summary: Afficher les bulletins multiples d'un groupe pour un semestre
 *     description: |
 *       Affiche les bulletins semestriels de tous les étudiants d'un groupe.
 *       - Semestre 1 ou Semestre 2 uniquement
 *     tags: [PV & Bulletins - Vue]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupeId
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID du groupe
 *       - in: path
 *         name: semestreId
 *         required: true
 *         schema:
 *           type: integer
 *           enum: [1, 2]
 *         description: ID du semestre
 *     responses:
 *       200:
 *         description: Bulletins semestriels multiples
 *       404:
 *         description: Groupe non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/vue/groupe/:groupeId/bulletins/semestre/:semestreId', authenticateToken, pvController.afficherBulletinsMultiples);

module.exports = router;
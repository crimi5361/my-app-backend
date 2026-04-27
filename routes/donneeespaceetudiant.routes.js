const express = require('express');
const router = express.Router();
const etudiantController = require('../controllers/donneeespaceetudiant.controller');
const { uploadStudentFiles } = require('../middleware/upload');

/**
 * @swagger
 * components:
 *   schemas:
 *     StudentProfileResponse:
 *       type: object
 *       properties:
 *         informations_personnelles:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *             matricule:
 *               type: string
 *             nom:
 *               type: string
 *             prenoms:
 *               type: string
 *             date_naissance:
 *               type: string
 *               format: date
 *             lieu_naissance:
 *               type: string
 *             telephone:
 *               type: string
 *             email:
 *               type: string
 *             etablissement_origine:
 *               type: string
 *             lieu_residence:
 *               type: string
 *             contact_parent:
 *               type: string
 *             contact_parent_2:
 *               type: string
 *             contact_etudiant:
 *               type: string
 *             sexe:
 *               type: string
 *               enum: [M, F]
 *             nationalite:
 *               type: string
 *             pays_naissance:
 *               type: string
 *             photo_url:
 *               type: string
 *             numero_table:
 *               type: string
 *         informations_familiales:
 *           type: object
 *           properties:
 *             nom_parent_1:
 *               type: string
 *             nom_parent_2:
 *               type: string
 *         informations_academiques:
 *           type: object
 *           properties:
 *             code_unique:
 *               type: string
 *             annee_bac:
 *               type: string
 *             serie_bac:
 *               type: string
 *             annee_academique:
 *               type: string
 *             niveau:
 *               type: string
 *             filiere:
 *               type: string
 *             type_parcours:
 *               type: string
 *             groupe:
 *               type: string
 *             classe:
 *               type: string
 *         documents:
 *           type: object
 *           properties:
 *             extrait_naissance:
 *               type: string
 *             justificatif_identite:
 *               type: string
 *             dernier_diplome:
 *               type: string
 *             fiche_orientation:
 *               type: string
 *             statut_documents:
 *               type: object
 *               properties:
 *                 complet:
 *                   type: boolean
 *         scolarite:
 *           type: object
 *           properties:
 *             montant_total:
 *               type: number
 *             montant_verse:
 *               type: number
 *             montant_restant:
 *               type: number
 *             statut:
 *               type: string
 *         statut:
 *           type: object
 *           properties:
 *             statut_scolaire:
 *               type: string
 *             standing:
 *               type: string
 *             date_inscription:
 *               type: string
 *               format: date-time
 *     
 *     InfoProfileResponse:
 *       type: object
 *       properties:
 *         informations_personnelles:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *             matricule:
 *               type: string
 *             nom:
 *               type: string
 *             prenoms:
 *               type: string
 *             date_naissance:
 *               type: string
 *               format: date
 *             lieu_naissance:
 *               type: string
 *             telephone:
 *               type: string
 *             email:
 *               type: string
 *             etablissement_origine:
 *               type: string
 *             lieu_residence:
 *               type: string
 *             contact_parent:
 *               type: string
 *             contact_parent_2:
 *               type: string
 *             contact_etudiant:
 *               type: string
 *             sexe:
 *               type: string
 *             nationalite:
 *               type: string
 *             pays_naissance:
 *               type: string
 *             photo_url:
 *               type: string
 *             numero_table:
 *               type: string
 *             ip_ministere:
 *               type: string
 *             serie_bac:
 *               type: string
 *             annee_bac:
 *               type: string
 *             code_unique:
 *               type: string
 *             is_profile_complete:
 *               type: boolean
 *         informations_familiales:
 *           type: object
 *           properties:
 *             nom_parent_1:
 *               type: string
 *             nom_parent_2:
 *               type: string
 *     
 *     UpdateProfileRequest:
 *       type: object
 *       properties:
 *         etablissement_origine:
 *           type: string
 *         date_naissance:
 *           type: string
 *           format: date
 *         matricule_mers:
 *           type: string
 *           description: Matricule MERS
 *         numero_table_bac:
 *           type: string
 *           description: Numéro de table au baccalauréat
 *         matricule_menet:
 *           type: string
 *           description: IP Ministère
 *         lieu_naissance:
 *           type: string
 *         sexe:
 *           type: string
 *           enum: [M, F]
 *         serie_bac:
 *           type: string
 *         annee_bac:
 *           type: string
 *         lieu_residence:
 *           type: string
 *         pays_naissance:
 *           type: string
 *     
 *     UpdateProfileResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         data:
 *           type: object
 *         is_profile_complete:
 *           type: boolean
 *     
 *     UpdatePhotoResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *         message:
 *           type: string
 *         data:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *             nom:
 *               type: string
 *             prenoms:
 *               type: string
 *             photo_url:
 *               type: string
 *             full_url:
 *               type: string
 */

/**
 * @swagger
 * /api/donneeespaceetudiant/profile/{id}:
 *   get:
 *     summary: Récupérer le profil complet d'un étudiant
 *     description: |
 *       Retourne toutes les informations d'un étudiant organisées par catégories :
 *       - Informations personnelles
 *       - Informations familiales
 *       - Informations académiques
 *       - Documents fournis
 *       - Scolarité
 *       - Statut
 *       - Administration
 *     tags: [Espace Étudiant]
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
 *         description: Profil récupéré avec succès
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StudentProfileResponse'
 *       404:
 *         description: Étudiant non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/profile/:id', etudiantController.getStudentProfile);

/**
 * @swagger
 * /api/donneeespaceetudiant/infoProfile/{id}:
 *   get:
 *     summary: Récupérer les informations simplifiées du profil
 *     description: |
 *       Retourne les informations essentielles du profil étudiant.
 *       Utile pour la page d'édition de profil.
 *       Inclut un flag `is_profile_complete` indiquant si le profil est complet.
 *     tags: [Espace Étudiant]
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
 *         description: Informations récupérées avec succès
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/InfoProfileResponse'
 *             example:
 *               informations_personnelles:
 *                 id: 123
 *                 nom: "DIALLO"
 *                 prenoms: "Mamadou Amadou"
 *                 date_naissance: "1995-05-15"
 *                 telephone: "+221771234567"
 *                 is_profile_complete: false
 *               informations_familiales:
 *                 nom_parent_1: "Diallo Amadou"
 *                 nom_parent_2: null
 *       404:
 *         description: Étudiant non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.get('/infoProfile/:id', etudiantController.getinfoProfile);

/**
 * @swagger
 * /api/donneeespaceetudiant/mise-a-jour-profile/{id}:
 *   post:
 *     summary: Mettre à jour le profil d'un étudiant
 *     description: |
 *       Met à jour les informations du profil étudiant.
 *       - Tous les champs sont optionnels
 *       - Le profil est automatiquement marqué comme complet quand tous les champs requis sont remplis
 *       - Champs requis pour profil complet : etablissement_origine, date_naissance, matricule, numero_table, ip_ministere, lieu_naissance, sexe, serie_bac, annee_bac, lieu_residence, pays_naissance
 *     tags: [Espace Étudiant]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'étudiant
 *         example: 123
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateProfileRequest'
 *           example:
 *             etablissement_origine: "Lycée de Dakar"
 *             date_naissance: "1995-05-15"
 *             matricule_mers: "MERS2024001"
 *             numero_table_bac: "T001"
 *             matricule_menet: "IP2024001"
 *             lieu_naissance: "Dakar"
 *             sexe: "M"
 *             serie_bac: "C"
 *             annee_bac: "2023"
 *             lieu_residence: "Dakar, Sicap Liberté"
 *             pays_naissance: "Sénégal"
 *     responses:
 *       200:
 *         description: Profil mis à jour avec succès
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UpdateProfileResponse'
 *             examples:
 *               complet:
 *                 value:
 *                   success: true
 *                   message: "Profil mis à jour avec succès"
 *                   data: { id: 123, nom: "DIALLO", ... }
 *                   is_profile_complete: true
 *               partiel:
 *                 value:
 *                   success: true
 *                   message: "Profil mis à jour avec succès"
 *                   data: { id: 123, nom: "DIALLO", ... }
 *                   is_profile_complete: false
 *       400:
 *         description: Aucune donnée à mettre à jour
 *       404:
 *         description: Étudiant non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.post('/mise-a-jour-profile/:id', etudiantController.updateStudentProfile);

/**
 * @swagger
 * /api/donneeespaceetudiant/profile/{id}/photo:
 *   post:
 *     summary: Mettre à jour la photo de profil d'un étudiant
 *     description: |
 *       Met à jour la photo de profil de l'étudiant.
 *       - Formats acceptés : JPG, JPEG, PNG
 *       - Taille maximale : 2MB
 *       - L'ancienne photo est automatiquement supprimée
 *       - La nouvelle photo est stockée dans `/uploads/photos/`
 *     tags: [Espace Étudiant]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'étudiant
 *         example: 123
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               photo:
 *                 type: string
 *                 format: binary
 *                 description: Fichier photo (JPG, JPEG, PNG - max 2MB)
 *     responses:
 *       200:
 *         description: Photo mise à jour avec succès
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UpdatePhotoResponse'
 *             example:
 *               success: true
 *               message: "Photo de profil mise à jour avec succès"
 *               data:
 *                 id: 123
 *                 nom: "DIALLO"
 *                 prenoms: "Mamadou Amadou"
 *                 photo_url: "/uploads/photos/photo-123.jpg"
 *                 full_url: "http://localhost:3000/uploads/photos/photo-123.jpg"
 *       400:
 *         description: |
 *           Erreur de validation :
 *           - Aucun fichier fourni
 *           - Format invalide (uniquement JPG, JPEG, PNG)
 *           - Fichier trop volumineux (> 2MB)
 *       404:
 *         description: Étudiant non trouvé
 *       500:
 *         description: Erreur serveur
 */
router.post('/profile/:id/photo', uploadStudentFiles().single('photo'), etudiantController.updateStudentPhoto);

module.exports = router;
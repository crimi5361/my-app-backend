const express = require('express');
const router = express.Router();
const publicController = require('../controllers/public.controller');
const etudiantController = require('../controllers/etudiant.controller');
const publicReinscriptionController = require('../controllers/publicReinscription.controller');
const publicEnseignantController = require('../controllers/publicEnseignant.controller');
const { uploadCandidatureFiles } = require('../middleware/upload');

// Routes publiques sans authentification
router.get('/public/classes/liste', publicController.getListeClassesPublic);
router.get('/public/classe/:id', publicController.getDetailClassePublic);
router.get('/public/groupe/:id', publicController.getDetailGroupePublic);
router.get('/annees-academiques', publicController.getPublicAnneesAcademiques);

// Préinscription en ligne (site public — sans authentification)
router.get('/public/admission/reference-data', publicController.getReferenceDataAdmission);
router.get('/public/admission/departements', publicController.getDepartementsPublic);
router.get('/public/admission/filieres', publicController.getFilieresAvecNiveauxPublic);
router.get('/public/admission/tarif', publicController.getTarifPreviewPublic);
router.post('/public/admission', publicController.demanderAdmissionPublic);
router.get('/public/admission/:id/fiche', etudiantController.afficherFicheInscriptionPublique);

// Réinscription en ligne (site public — sans authentification)
router.get('/public/reinscription/recherche', publicReinscriptionController.rechercherEtudiantReinscriptionPublic);
router.get('/public/reinscription/etudiant/:id/situation', publicReinscriptionController.getSituationReinscriptionPublic);
router.post('/public/reinscription/etudiant/:id/demander', publicReinscriptionController.demanderReinscriptionPublic);
router.get('/public/reinscription/:reinscriptionId/fiche', publicReinscriptionController.getFicheReinscriptionPublic);
router.get('/public/reinscription/etudiant/:id/fiche-situation', publicReinscriptionController.getFicheSituationBloqueePublic);

// Recrutement enseignant en ligne (site institutionnel — sans authentification).
// Module Gestion des Enseignants, 2026-08-11.
router.get('/enseignants/offres', publicEnseignantController.getOffresPubliques);
router.get('/enseignants/offres/:reference', publicEnseignantController.getOffrePublique);
router.get('/enseignants/filieres', publicEnseignantController.getFilieresPubliques);
router.get('/enseignants/candidature/:reference/suivi', publicEnseignantController.suivreCandidature);
router.post(
  '/enseignants/candidature',
  uploadCandidatureFiles().fields([
    { name: 'cv', maxCount: 1 },
    { name: 'diplomes', maxCount: 10 },
  ]),
  publicEnseignantController.deposerCandidature
);

module.exports = router;
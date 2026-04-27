const express = require('express');
const router = express.Router();
const publicController = require('../controllers/public.controller');

// Routes publiques sans authentification
router.get('/public/classes/liste', publicController.getListeClassesPublic);
router.get('/public/classe/:id', publicController.getDetailClassePublic);
router.get('/public/groupe/:id', publicController.getDetailGroupePublic);
router.get('/annees-academiques', publicController.getPublicAnneesAcademiques);

module.exports = router;
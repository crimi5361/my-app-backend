const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/authorize.middleware');
const edt = require('../controllers/edtPlanification.controller');

const planificateur = authorizeRoles('admin', 'charge_pedagogique');
// La scolarité et les RH consultent l'emploi du temps sans pouvoir le modifier.
const lecteur = authorizeRoles('admin', 'charge_pedagogique', 'rh', 'scolarite');

// Trames (maquette théorique)
router.get('/trames', authenticateToken, lecteur, edt.getTrames);
router.post('/trames', authenticateToken, planificateur, edt.createTrame);
router.put('/trames/:id', authenticateToken, planificateur, edt.updateTrame);
router.patch('/trames/:id/annuler', authenticateToken, planificateur, edt.annulerTrame);

// Séances datées et allocation des salles
router.get('/seances', authenticateToken, lecteur, edt.getSeances);
router.post('/seances', authenticateToken, planificateur, edt.createSeance);
router.get('/seances/:id/salles-disponibles', authenticateToken, planificateur, edt.getSallesPourSeance);
router.patch('/seances/:id/salle', authenticateToken, planificateur, edt.affecterSalle);
router.patch('/seances/:id', authenticateToken, planificateur, edt.updateSeance);
router.delete('/seances/:id', authenticateToken, planificateur, edt.supprimerSeance);
router.post('/allocation-groupee', authenticateToken, planificateur, edt.affecterSalleEnLot);

module.exports = router;

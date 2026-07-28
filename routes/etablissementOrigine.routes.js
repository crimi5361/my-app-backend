const express = require('express');
const router = express.Router();
const EtablissementOrigineController = require('../controllers/etablissementOrigine.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken, EtablissementOrigineController.getAllEtablissements);
router.get('/:id', authenticateToken, EtablissementOrigineController.getEtablissementById);
router.post('/', authenticateToken, EtablissementOrigineController.createEtablissement);
router.put('/:id', authenticateToken, EtablissementOrigineController.updateEtablissement);
router.delete('/:id', authenticateToken, EtablissementOrigineController.deleteEtablissement);

module.exports = router;

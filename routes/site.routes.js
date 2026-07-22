const express = require('express');
const router = express.Router();
const SiteController = require('../controllers/site.controller');
const authenticateToken = require('../middleware/auth.middleware');

router.get('/', authenticateToken, SiteController.getAllSites);
router.get('/:id', authenticateToken, SiteController.getSiteById);
router.post('/', authenticateToken, SiteController.createSite);
router.put('/:id', authenticateToken, SiteController.updateSite);
router.delete('/:id', authenticateToken, SiteController.deleteSite);

module.exports = router;

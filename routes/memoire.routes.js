// routes/memoire.routes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const memoireController = require('../controllers/memoire.controller');

// Configuration du dossier d'upload temporaire (multer)
const tempUploadDir = path.join(__dirname, '../uploads/temp');

// S'assurer que le dossier temporaire existe
if (!fs.existsSync(tempUploadDir)) {
    fs.mkdirSync(tempUploadDir, { recursive: true });
}

// Configuration du stockage multer (temporaire)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, tempUploadDir);
    },

    filename: function (req, file, cb) {
        // Générer un nom unique temporaire
        const uniqueSuffix = Date.now() + '_' + Math.round(Math.random() * 1E9);
        const safeName = file.originalname.replace(/\s/g, '_');
        cb(null, uniqueSuffix + '_' + safeName);
    }
});

// Filtre pour accepter uniquement les PDF
const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
        cb(null, true);
    } else {
        cb(new Error('Seuls les fichiers PDF sont autorisés'), false);
    }
};

// Initialisation de multer
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10 Mo maximum
    }
});

//  Configuration spécifique pour le rapport d'analyse (5 Mo max)
const uploadRapport = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5 Mo maximum pour le rapport
    }
});

// Routes
router.post('/deposer', upload.single('fichier'), memoireController.postChargerPdf);
router.get('/etudiant/:etudiant_id', memoireController.getMemoiresByEtudiant);
router.get('/:id', memoireController.getMemoireById);
router.get('/', memoireController.getAllMemoires);
router.get('/filiere/:filiere/:classe', memoireController.getMemoiresByFiliereEtClasse);
router.put('/:id/valider', memoireController.validerMemoire);

// Route modifiée pour le rejet avec upload du rapport
router.put('/:id/rejeter', uploadRapport.single('rapport_analyse'), memoireController.rejeterMemoire);

router.put('/:id/encourtraitement', memoireController.TraitementMemoire);

// Mettre à jour un mémoire (remplacement dans les 30 min)
router.put('/:id/update', upload.single('fichier'), memoireController.updateMemoire);

// Récupérer le dernier mémoire avec vérification du délai
router.get('/etudiant/:etudiant_id/dernier', memoireController.getDernierMemoireAvecDelai);

module.exports = router;
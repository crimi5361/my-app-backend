// controllers/emploiDuTempsController.js
const db = require('../config/db.config');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Configuration spécifique pour les emplois du temps
const storageEmploiDuTemps = multer.diskStorage({
  destination: (req, file, cb) => {
    // Crée un dossier par groupe_id pour mieux organiser
    const groupeDir = path.join(__dirname, '../uploads/emplois_du_temps', req.params.id);
    if (!fs.existsSync(groupeDir)) {
      fs.mkdirSync(groupeDir, { recursive: true });
    }
    cb(null, groupeDir);
  },
  filename: (req, file, cb) => {
    // Garde le nom original mais ajoute un timestamp pour éviter les conflits
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'edt-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadEmploiDuTemps = multer({
  storage: storageEmploiDuTemps,
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB
  },
  fileFilter: (req, file, cb) => {
    // Accepte PDF, Word, Excel
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Type de fichier non supporté. Formats acceptés: PDF, Word, Excel'), false);
    }
  }
});

// Uploader l'emploi du temps
exports.uploadEmploiDuTemps = [
  uploadEmploiDuTemps.single('emploiDuTemps'),
  async (req, res) => {
    try {
      const groupeId = req.params.id;
      
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'Veuillez sélectionner un fichier'
        });
      }

      // Vérifier si le groupe existe
      const groupeResult = await db.query('SELECT * FROM groupe WHERE id = $1', [groupeId]);
      if (groupeResult.rows.length === 0) {
        // Supprime le fichier uploadé si le groupe n'existe pas
        fs.unlinkSync(req.file.path);
        return res.status(404).json({
          success: false,
          message: 'Groupe non trouvé'
        });
      }

      const filePath = req.file.path;
      const originalName = req.file.originalname;

      // Vérifier si un EDT existe déjà pour ce groupe
      const existingEdt = await db.query(
        'SELECT * FROM emploi_du_temps WHERE groupe_id = $1',
        [groupeId]
      );

      let result;
      if (existingEdt.rows.length > 0) {
        // Supprime l'ancien fichier physique
        try {
          fs.unlinkSync(existingEdt.rows[0].file_path);
        } catch (error) {
          console.warn('Impossible de supprimer l\'ancien fichier:', error);
        }

        // Met à jour la base de données
        result = await db.query(
          `UPDATE emploi_du_temps 
           SET file_path = $1, original_name = $2, uploaded_at = NOW() 
           WHERE groupe_id = $3 
           RETURNING *`,
          [filePath, originalName, groupeId]
        );
      } else {
        // Insère une nouvelle entrée
        result = await db.query(
          `INSERT INTO emploi_du_temps (groupe_id, file_path, original_name) 
           VALUES ($1, $2, $3) 
           RETURNING *`,
          [groupeId, filePath, originalName]
        );
      }

      res.json({
        success: true,
        message: 'Emploi du temps téléchargé avec succès',
        data: result.rows[0]
      });

    } catch (error) {
      console.error('Erreur upload EDT:', error);
      
      // Supprime le fichier en cas d'erreur
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (unlinkError) {
          console.warn('Impossible de supprimer le fichier:', unlinkError);
        }
      }

      res.status(500).json({
        success: false,
        message: 'Erreur lors du téléchargement de l\'emploi du temps'
      });
    }
  }
];

// Récupérer l'emploi du temps d'un groupe
exports.getEmploiDuTemps = async (req, res) => {
  try {
    const groupeId = req.params.id;

    const result = await db.query(
      `SELECT * FROM emploi_du_temps 
       WHERE groupe_id = $1 
       ORDER BY uploaded_at DESC 
       LIMIT 1`,
      [groupeId]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: null,
        message: 'Aucun emploi du temps trouvé pour ce groupe'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Erreur récupération EDT:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de l\'emploi du temps'
    });
  }
};

// Télécharger le fichier
exports.downloadEmploiDuTemps = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      'SELECT * FROM emploi_du_temps WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Fichier non trouvé'
      });
    }

    const emploiDuTemps = result.rows[0];
    const filePath = emploiDuTemps.file_path;

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Fichier introuvable sur le serveur'
      });
    }

    res.download(filePath, emploiDuTemps.original_name);

  } catch (error) {
    console.error('Erreur téléchargement EDT:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du téléchargement du fichier'
    });
  }
};
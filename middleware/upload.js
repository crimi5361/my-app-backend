const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configuration pour les photos d'étudiants
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/photos');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'photo_' + uniqueSuffix + path.extname(file.originalname));
  }
});

// Configuration pour les pièces justificatives (document_etudiant)
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/documents');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'doc_' + uniqueSuffix + path.extname(file.originalname));
  }
});

const uploadStudentFiles = () => {
  return multer({
    storage: photoStorage,
    limits: {
      fileSize: 8 * 1024 * 1024 // 8MB
    },
    fileFilter: (req, file, cb) => {
      const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png'];
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Format de photo invalide. Formats acceptés: JPG, JPEG, PNG'), false);
      }
    }
  });
};

// Upload multi-champs : 'photo' (image uniquement, uploads/photos) + 'documents[]' (image ou PDF, uploads/documents)
const uploadAdmissionFiles = () => {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = file.fieldname === 'photo'
          ? path.join(__dirname, '../uploads/photos')
          : path.join(__dirname, '../uploads/documents');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const prefix = file.fieldname === 'photo' ? 'photo_' : 'doc_';
        cb(null, prefix + uniqueSuffix + path.extname(file.originalname));
      }
    }),
    limits: {
      fileSize: 8 * 1024 * 1024 // 8MB
    },
    fileFilter: (req, file, cb) => {
      const allowedImages = ['image/jpeg', 'image/jpg', 'image/png'];
      if (file.fieldname === 'photo') {
        return allowedImages.includes(file.mimetype)
          ? cb(null, true)
          : cb(new Error('Format de photo invalide. Formats acceptés: JPG, JPEG, PNG'), false);
      }
      const allowedDocs = [...allowedImages, 'application/pdf'];
      return allowedDocs.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error('Format de pièce invalide. Formats acceptés: JPG, JPEG, PNG, PDF'), false);
    }
  });
};

// Candidature enseignant (module Gestion des Enseignants, 2026-08-11) — déposée depuis
// le site institutionnel, donc sans authentification : le filtre de type et la limite de
// taille sont ici la seule barrière contre l'envoi de fichiers arbitraires.
// Répertoire dédié (uploads/candidatures) pour ne pas mélanger ces pièces avec les
// dossiers étudiants, dont le cycle de vie et la confidentialité sont différents.
const uploadCandidatureFiles = () => {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../uploads/candidatures');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const prefix = file.fieldname === 'cv' ? 'cv_' : 'diplome_';
        cb(null, prefix + uniqueSuffix + path.extname(file.originalname));
      }
    }),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
      files: 11                  // 1 CV + 10 diplômes au maximum
    },
    fileFilter: (req, file, cb) => {
      const allowed = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
      return allowed.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error('Format de fichier invalide. Formats acceptés : PDF, JPG, JPEG, PNG'), false);
    }
  });
};

module.exports = {
  uploadStudentFiles,
  uploadAdmissionFiles,
  uploadCandidatureFiles
};
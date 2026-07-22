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

module.exports = {
  uploadStudentFiles,
  uploadAdmissionFiles
};
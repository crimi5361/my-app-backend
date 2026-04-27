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

module.exports = {
  uploadStudentFiles
};
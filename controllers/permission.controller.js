const db = require('../config/db.config');

// Ajouter une permission

// Récupérer toutes les permissions
exports.getAllPermissions = async (req, res) => {
  try {
    const result = await db.query('SELECT id, nom, description FROM permission');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des permissions:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

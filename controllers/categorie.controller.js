const db = require('../config/db.config');

exports.getCategories = async (req, res) => {
  try {
    const query = 'SELECT id, nom FROM categorie ORDER BY nom';
    const result = await db.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des catégories:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};
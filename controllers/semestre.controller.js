const pool = require('../config/db.config');

// Liste des semestres
exports.getSemestres = async (req, res) => {
  try {
    const query = 'SELECT id, nom  FROM semestre ORDER BY nom';
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des semestres:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};
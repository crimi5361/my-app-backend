 const db = require('../config/db.config');

 // Récupérer toutes les roles
exports.getAllDepartements = async (req, res) => {
  try {
    const result = await db.query('SELECT id, nom FROM public.departement');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des roles:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};
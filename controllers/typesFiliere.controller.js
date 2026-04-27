const db = require('../config/db.config');

exports.getAllTypesFiliere = async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM typefiliere');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des types de filière:', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
};
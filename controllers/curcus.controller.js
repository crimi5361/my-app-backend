 const db = require('../config/db.config');

 exports.getAllCursus = async (req, res) => {
    try {
        const result = await db.query('SELECT  id, type_parcours FROM curcus');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des cursus:', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
}
const db = require('../config/db.config');

exports.getNiveauxByFiliere = async (req, res) => {
    try {
        const { filiereId } = req.params; // récupération de l'ID depuis l'URL

        const result = await db.query(`
            SELECT id, libelle, prix_formation, type_filiere, filiere_id
            FROM niveau
            WHERE filiere_id = $1
        `, [filiereId]);

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des niveaux :', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
};

exports.getAllNiveau = async (req, res) => {
    const result = await db.query(`
       SELECT DISTINCT ON (n.libelle)
            n.libelle,
            n.prix_formation,
            tf.description AS typefiliere_description,
            tf.libelle AS typefiliere_libelle
        FROM niveau n
        JOIN typefiliere tf ON CAST(n.type_filiere AS INT) = tf.id
        ORDER BY n.libelle, n.id;

    `);
    res.status(200).json(result.rows);
}
                                    
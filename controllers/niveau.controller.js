const db = require('../config/db.config');

exports.getNiveauxByFiliere = async (req, res) => {
    try {
        const { filiereId } = req.params; // récupération de l'ID depuis l'URL
        const { site_id, anneeacademique_id } = req.query;

        const conditions = ['filiere_id = $1'];
        const params = [filiereId];

        if (site_id) {
            params.push(site_id);
            conditions.push(`site_id = $${params.length}`);
        }
        if (anneeacademique_id) {
            params.push(anneeacademique_id);
            conditions.push(`anneeacademique_id = $${params.length}`);
        }

        const result = await db.query(`
            SELECT id, libelle, prix_formation, type_filiere, filiere_id, site_id, anneeacademique_id
            FROM niveau
            WHERE ${conditions.join(' AND ')}
        `, params);

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des niveaux :', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
};

// Liste des niveaux réellement configurés (un par filière), pour l'année académique
// demandée — auparavant réduits en un seul par libellé via DISTINCT ON, ce qui masquait
// les 9/10 des niveaux existants (chaque filière a son propre niveau "LICENCE 1", etc.).
exports.getAllNiveau = async (req, res) => {
    try {
        const { site_id, anneeacademique_id } = req.query;

        const conditions = [];
        const params = [];
        if (site_id) {
            params.push(site_id);
            conditions.push(`n.site_id = $${params.length}`);
        }
        if (anneeacademique_id) {
            params.push(anneeacademique_id);
            conditions.push(`n.anneeacademique_id = $${params.length}`);
        }
        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await db.query(`
           SELECT
                n.id,
                n.libelle,
                n.prix_formation,
                n.filiere_id,
                n.site_id,
                n.anneeacademique_id,
                f.nom AS filiere_nom,
                f.sigle AS filiere_sigle,
                tf.description AS typefiliere_description,
                tf.libelle AS typefiliere_libelle
            FROM niveau n
            LEFT JOIN typefiliere tf ON n.type_filiere IS NOT NULL AND n.type_filiere ~ '^[0-9]+$' AND CAST(n.type_filiere AS INT) = tf.id
            LEFT JOIN filiere f ON f.id = n.filiere_id
            ${whereClause}
            ORDER BY f.nom, n.libelle;
        `, params);

        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des niveaux :', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
}
                                    
const db = require('../config/db.config');

// Statistiques par cycles (Type de filière)
exports.getStatisticsByCycle = async (req, res) => {
    try {
        const { annee_academique_id, departement_id } = req.query;

        let query = `
            SELECT 
                tf.id as cycle_id,
                tf.libelle as cycle,
                COUNT(CASE WHEN e.statut_scolaire = 'Affecté' THEN 1 END) as etudiants_affectes,
                COUNT(CASE WHEN e.statut_scolaire = 'Non affecté' THEN 1 END) as etudiants_non_affectes,
                COUNT(CASE WHEN e.standing = 'Inscrit' THEN 1 END) as inscriptions,
                COUNT(CASE WHEN n.libelle IN ('LICENCE 2', 'LICENCE 3', 'BTS 2') AND e.standing = 'Inscrit' THEN 1 END) as reinscriptions,
                COUNT(*) as total
            FROM etudiant e
            INNER JOIN niveau n ON e.niveau_id = n.id
            INNER JOIN filiere f ON n.filiere_id = f.id
            INNER JOIN typefiliere tf ON f.type_filiere_id = tf.id
            WHERE e.annee_academique_id = $1 AND e.departement_id = $2
            GROUP BY tf.id, tf.libelle
            ORDER BY tf.libelle
        `;

        const result = await db.query(query, [annee_academique_id, departement_id]);
        
        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Erreur statistiques par cycle:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur'
        });
    }
};

// Statistiques par niveaux (regroupés par nom de niveau)
exports.getStatisticsByNiveau = async (req, res) => {
    try {
        const { annee_academique_id, departement_id } = req.query;

        let query = `
            SELECT 
                n.libelle as niveau,
                COUNT(CASE WHEN e.statut_scolaire = 'Affecté' THEN 1 END) as etudiants_affectes,
                COUNT(CASE WHEN e.statut_scolaire = 'Non affecté' THEN 1 END) as etudiants_non_affectes,
                COUNT(CASE WHEN e.standing = 'Inscrit' THEN 1 END) as inscriptions,
                COUNT(CASE WHEN n.libelle IN ('LICENCE 2', 'LICENCE 3', 'BTS 2') AND e.standing = 'Inscrit' THEN 1 END) as reinscriptions,
                COUNT(*) as total
            FROM etudiant e
            INNER JOIN niveau n ON e.niveau_id = n.id
            WHERE e.annee_academique_id = $1 AND e.departement_id = $2 AND e.standing='Inscrit'
            GROUP BY n.libelle
            ORDER BY 
                 CASE 
                    WHEN n.libelle LIKE 'BTS 1' THEN 1
                    WHEN n.libelle LIKE 'BTS 2' THEN 2
                    WHEN n.libelle LIKE 'LICENCE 1' THEN 3
                    WHEN n.libelle LIKE 'LICENCE 2' THEN 4
                    WHEN n.libelle LIKE 'LICENCE 3' THEN 5
                    WHEN n.libelle LIKE 'LICENCE 1 PRO' THEN 6
                    WHEN n.libelle LIKE 'LICENCE 2 PRO' THEN 7
                    WHEN n.libelle LIke 'LICENCE 3 PRO' THEN 8
                    WHEN n.libelle LIKE 'MASTER 1' THEN 9
                    WHEN n.libelle LIKE 'MASTER 2' THEN 10
                    WHEN n.libelle LIKE 'MASTER 1 PRO' THEN 11
                    WHEN n.libelle LIKE 'MASTER 2 PRO' THEN 12
                    ELSE 13
                END
        `;

        const result = await db.query(query, [annee_academique_id, departement_id]);
        
        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Erreur statistiques par niveau:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur'
        });
    }
};

// Statistiques par cursus (type de parcours)
exports.getStatisticsByCursus = async (req, res) => {
    try {
        const { annee_academique_id, departement_id } = req.query;

        let query = `
            SELECT 
                c.id as cursus_id,
                c.type_parcours as cursus,
                COUNT(CASE WHEN e.statut_scolaire = 'Affecté' THEN 1 END) as etudiants_affectes,
                COUNT(CASE WHEN e.statut_scolaire = 'Non affecté' THEN 1 END) as etudiants_non_affectes,
                COUNT(CASE WHEN e.standing = 'Inscrit' THEN 1 END) as inscriptions,
                COUNT(CASE WHEN n.libelle IN ('LICENCE 2', 'LICENCE 3', 'BTS 2') AND e.standing = 'Inscrit' THEN 1 END) as reinscriptions,
                COUNT(*) as total
            FROM etudiant e
            INNER JOIN niveau n ON e.niveau_id = n.id
            INNER JOIN curcus c ON e.curcus_id = c.id
            WHERE e.annee_academique_id = $1 AND e.departement_id = $2
            GROUP BY c.id, c.type_parcours
            ORDER BY c.type_parcours
        `;

        const result = await db.query(query, [annee_academique_id, departement_id]);
        
        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('Erreur statistiques par cursus:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur'
        });
    }
};

// Statistiques par filière avec détails des niveaux
exports.getStatisticsByFiliere = async (req, res) => {
    try {
        const { annee_academique_id, departement_id } = req.query;

        let query = `
            SELECT 
                f.id as filiere_id,
                f.nom as filiere,
                f.sigle,
                tf.libelle as type_filiere,
                n.libelle as niveau,
                COUNT(CASE WHEN e.statut_scolaire = 'Affecté' THEN 1 END) as etudiants_affectes,
                COUNT(CASE WHEN e.statut_scolaire = 'Non affecté' THEN 1 END) as etudiants_non_affectes,
                COUNT(CASE WHEN e.standing = 'Inscrit' THEN 1 END) as inscriptions,
                COUNT(CASE WHEN n.libelle IN ('LICENCE 2', 'LICENCE 3', 'BTS 2') AND e.standing = 'Inscrit' THEN 1 END) as reinscriptions,
                COUNT(*) as total
            FROM etudiant e
            INNER JOIN niveau n ON e.niveau_id = n.id
            INNER JOIN filiere f ON n.filiere_id = f.id
            INNER JOIN typefiliere tf ON f.type_filiere_id = tf.id
            WHERE e.annee_academique_id = $1 AND e.departement_id = $2
            GROUP BY f.id, f.nom, f.sigle, tf.libelle, n.libelle, n.id
            ORDER BY f.nom, 
                CASE 
                    WHEN n.libelle LIKE 'LICENCE 1' THEN 1
                    WHEN n.libelle LIKE 'LICENCE 2' THEN 2
                    WHEN n.libelle LIKE 'LICENCE 3' THEN 3
                    WHEN n.libelle LIKE 'MASTER 1' THEN 4
                    WHEN n.libelle LIKE 'MASTER 2' THEN 5
                    WHEN n.libelle LIKE 'BTS 1' THEN 6
                    WHEN n.libelle LIKE 'BTS 2' THEN 7
                    ELSE 8
                END
        `;

        const result = await db.query(query, [annee_academique_id, departement_id]);
        
        // Regrouper par filière
        const groupedData = {};
        result.rows.forEach(row => {
            if (!groupedData[row.filiere_id]) {
                groupedData[row.filiere_id] = {
                    filiere_id: row.filiere_id,
                    filiere: row.filiere,
                    sigle: row.sigle,
                    type_filiere: row.type_filiere,
                    niveaux: [],
                    total_etudiants_affectes: 0,
                    total_etudiants_non_affectes: 0,
                    total_inscriptions: 0,
                    total_reinscriptions: 0,
                    total_general: 0
                };
            }

            groupedData[row.filiere_id].niveaux.push({
                niveau: row.niveau,
                etudiants_affectes: row.etudiants_affectes,
                etudiants_non_affectes: row.etudiants_non_affectes,
                inscriptions: row.inscriptions,
                reinscriptions: row.reinscriptions,
                total: row.total
            });

            // Totaux par filière
            groupedData[row.filiere_id].total_etudiants_affectes += parseInt(row.etudiants_affectes);
            groupedData[row.filiere_id].total_etudiants_non_affectes += parseInt(row.etudiants_non_affectes);
            groupedData[row.filiere_id].total_inscriptions += parseInt(row.inscriptions);
            groupedData[row.filiere_id].total_reinscriptions += parseInt(row.reinscriptions);
            groupedData[row.filiere_id].total_general += parseInt(row.total);
        });

        res.json({
            success: true,
            data: Object.values(groupedData)
        });

    } catch (error) {
        console.error('Erreur statistiques par filière:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur'
        });
    }
};

// Statistiques détaillées combinées
exports.getDetailedStatistics = async (req, res) => {
    try {
        const { annee_academique_id, departement_id } = req.query;

        // Exécuter toutes les requêtes en parallèle
        const [
            cycleStats,
            niveauStats,
            cursusStats,
            filiereStats
        ] = await Promise.all([
            db.query(`
                SELECT tf.libelle as cycle, COUNT(*) as total
                FROM etudiant e
                INNER JOIN niveau n ON e.niveau_id = n.id
                INNER JOIN filiere f ON n.filiere_id = f.id
                INNER JOIN typefiliere tf ON f.type_filiere_id = tf.id
                WHERE e.annee_academique_id = $1 AND e.departement_id = $2
                GROUP BY tf.libelle
            `, [annee_academique_id, departement_id]),
            
            db.query(`
                SELECT n.libelle as niveau, COUNT(*) as total
                FROM etudiant e
                INNER JOIN niveau n ON e.niveau_id = n.id
                WHERE e.annee_academique_id = $1 AND e.departement_id = $2
                GROUP BY n.libelle
            `, [annee_academique_id, departement_id]),
            
            db.query(`
                SELECT c.type_parcours as cursus, COUNT(*) as total
                FROM etudiant e
                INNER JOIN curcus c ON e.curcus_id = c.id
                WHERE e.annee_academique_id = $1 AND e.departement_id = $2
                GROUP BY c.type_parcours
            `, [annee_academique_id, departement_id]),
            
            db.query(`
                SELECT f.nom as filiere, COUNT(*) as total
                FROM etudiant e
                INNER JOIN niveau n ON e.niveau_id = n.id
                INNER JOIN filiere f ON n.filiere_id = f.id
                WHERE e.annee_academique_id = $1 AND e.departement_id = $2
                GROUP BY f.nom
            `, [annee_academique_id, departement_id])
        ]);

        res.json({
            success: true,
            data: {
                resume: {
                    total_etudiants: cycleStats.rows.reduce((sum, row) => sum + parseInt(row.total), 0),
                    par_cycle: cycleStats.rows,
                    par_niveau: niveauStats.rows,
                    par_cursus: cursusStats.rows,
                    par_filiere: filiereStats.rows
                }
            }
        });

    } catch (error) {
        console.error('Erreur statistiques détaillées:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur'
        });
    }
};
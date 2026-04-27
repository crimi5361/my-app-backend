const db = require('../config/db.config');

// 1. Récupérer TOUS les professeurs (ACTIFS seulement par défaut)
exports.getAllProfesseurs = async (req, res) => {
    try {
        const showInactifs = req.query.showInactifs === 'true';
        
        let query = `
            SELECT 
                p.id,
                p.nom,
                p.prenom,
                p.date_creation,
                p.statut,
                COUNT(e.id) as nombre_enseignements,
                STRING_AGG(DISTINCT m.nom, ', ') as matieres_enseignees
            FROM professeur p
            LEFT JOIN enseignement e ON p.id = e.professeur_id
            LEFT JOIN matiere m ON e.matiere_id = m.id
            WHERE 1=1
        `;
        
        const params = [];
        
        if (!showInactifs) {
            query += ` AND p.statut = 'Actif'`;
        }
        
        query += ` GROUP BY p.id
                   ORDER BY 
                    CASE WHEN p.statut = 'Actif' THEN 1 ELSE 2 END,
                    p.nom, p.prenom`;
        
        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};

// 2. Ajouter un professeur
exports.createProfesseur = async (req, res) => {
    try {
        const { nom, prenom } = req.body;
        
        if (!nom || !prenom) {
            return res.status(400).json({ error: 'Nom et prénom requis' });
        }
        
        const query = `
            INSERT INTO professeur (nom, prenom, statut)
            VALUES ($1, $2, 'Actif')
            RETURNING *
        `;
        
        const result = await db.query(query, [nom.trim(), prenom.trim()]);
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};

// 3. Mettre à jour un professeur
exports.updateProfesseur = async (req, res) => {
    try {
        const { id } = req.params;
        const { nom, prenom } = req.body;
        
        const query = `
            UPDATE professeur 
            SET nom = $1, prenom = $2
            WHERE id = $3
            RETURNING *
        `;
        
        const result = await db.query(query, [nom.trim(), prenom.trim(), id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Professeur non trouvé' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};

// 4. SOFT DELETE - Désactiver un professeur
exports.softDeleteProfesseur = async (req, res) => {
    try {
        const { id } = req.params;
        
        const checkQuery = await db.query(
            'SELECT id FROM professeur WHERE id = $1 AND statut = $2',
            [id, 'Actif']
        );
        
        if (checkQuery.rows.length === 0) {
            return res.status(404).json({ 
                error: 'Professeur non trouvé ou déjà inactif' 
            });
        }
        
        const query = `
            UPDATE professeur 
            SET statut = 'Inactif'
            WHERE id = $1
            RETURNING *
        `;
        
        const result = await db.query(query, [id]);
        
        res.json({ 
            message: 'Professeur désactivé avec succès',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};

// 5. Réactiver un professeur
exports.activateProfesseur = async (req, res) => {
    try {
        const { id } = req.params;
        
        const query = `
            UPDATE professeur 
            SET statut = 'Actif'
            WHERE id = $1 AND statut = 'Inactif'
            RETURNING *
        `;
        
        const result = await db.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                error: 'Professeur non trouvé ou déjà actif' 
            });
        }
        
        res.json({ 
            message: 'Professeur réactivé avec succès',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};

// 6. Récupérer les professeurs inactifs
exports.getInactifsProfesseurs = async (req, res) => {
    try {
        const query = `
            SELECT 
                p.id,
                p.nom,
                p.prenom,
                p.date_creation,
                p.statut
            FROM professeur p
            WHERE p.statut = 'Inactif'
            ORDER BY p.nom, p.prenom
        `;
        
        const result = await db.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};

// 7. Récupérer les détails des matières enseignées avec coûts et totaux
exports.getMatieresEnseigneesDetail = async (req, res) => {
    try {
        const { id } = req.params;
        const { annee_academique } = req.query;
        
        let query = `
            SELECT 
                e.id as enseignement_id,
                e.annee_academique,
                m.id as matiere_id,
                m.nom as matiere_nom,
                m.coefficient,
                m.type_evaluation,
                m.volume_horaire_cm,
                m.taux_horaire_cm,
                m.volume_horaire_td,
                m.taux_horaire_td,
                g.id as groupe_id,
                g.nom as groupe_nom,
                cl.id as classe_id,
                cl.nom as classe_nom,
                ROUND((COALESCE(m.volume_horaire_cm, 0) * COALESCE(m.taux_horaire_cm, 0) +
                 COALESCE(m.volume_horaire_td, 0) * COALESCE(m.taux_horaire_td, 0)))::integer as cout_total
            FROM enseignement e
            INNER JOIN matiere m ON e.matiere_id = m.id
            INNER JOIN groupe g ON e.groupe_id = g.id
            INNER JOIN classe cl ON g.classe_id = cl.id
            WHERE e.professeur_id = $1
        `;
        
        const params = [id];
        
        if (annee_academique) {
            query += ` AND e.annee_academique = $2`;
            params.push(annee_academique);
        }
        
        query += ` ORDER BY cl.nom, g.nom, m.nom`;
        
        const result = await db.query(query, params);
        
        // Calculer le coût total
        let totalCout = 0;
        const matieresAvecCout = result.rows.map(row => {
            const cout = parseInt(row.cout_total) || 0;
            totalCout += cout;
            return {
                ...row,
                cout_total: cout
            };
        });
        
        res.json({
            matieres: matieresAvecCout,
            total_cout: totalCout,
            nombre_matieres: matieresAvecCout.length
        });
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};

// 8. Récupérer un professeur par ID
exports.getProfesseurById = async (req, res) => {
    try {
        const { id } = req.params;
        
        const query = `
            SELECT 
                p.id,
                p.nom,
                p.prenom,
                p.date_creation,
                p.statut,
                COUNT(e.id) as nombre_enseignements
            FROM professeur p
            LEFT JOIN enseignement e ON p.id = e.professeur_id
            WHERE p.id = $1
            GROUP BY p.id
        `;
        
        const result = await db.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Professeur non trouvé' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Erreur:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};
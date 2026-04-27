const db = require('../config/db.config');

// 1. Récupérer toutes les évaluations chargées par groupe
exports.getEvaluationsByGroupe = async (req, res) => {
    try {
        const { groupeId } = req.params;
        const { annee_academique } = req.query;

        let query = `
            SELECT 
                e.id as enseignement_id,
                e.groupe_id,
                e.annee_academique,
                e.created_at as date_chargement,
                
                m.id as matiere_id,
                m.nom as matiere_nom,
                m.coefficient,
                m.type_evaluation,
                m.volume_horaire_cm,
                m.taux_horaire_cm,
                m.volume_horaire_td,
                m.taux_horaire_td,
                m.updated_at as matiere_updated_at,
                
                p.id as professeur_id,
                p.nom as professeur_nom,
                p.prenom as professeur_prenom,
                p.statut as professeur_statut,
                
                ue.id as ue_id,
                ue.libelle as ue_nom,
                
                s.id as semestre_id,
                s.nom as semestre_nom,
                
                g.nom as groupe_nom,
                g.capacite_max,
                
                cl.id as classe_id,
                cl.nom as classe_nom,
                
                (SELECT COUNT(*) FROM note WHERE enseignement_id = e.id) as nombre_notes,
                (SELECT COUNT(DISTINCT etudiant_id) FROM note WHERE enseignement_id = e.id) as nombre_etudiants,
                
                (COALESCE(m.volume_horaire_cm, 0) * COALESCE(m.taux_horaire_cm, 0) +
                 COALESCE(m.volume_horaire_td, 0) * COALESCE(m.taux_horaire_td, 0)) as cout_total
            FROM enseignement e
            INNER JOIN matiere m ON e.matiere_id = m.id
            INNER JOIN professeur p ON e.professeur_id = p.id
            LEFT JOIN ue ON m.ue_id = ue.id
            LEFT JOIN semestre s ON ue.semestre_id = s.id
            INNER JOIN groupe g ON e.groupe_id = g.id
            INNER JOIN classe cl ON g.classe_id = cl.id
            WHERE e.groupe_id = $1
        `;

        const params = [groupeId];

        if (annee_academique) {
            query += ` AND e.annee_academique = $2`;
            params.push(annee_academique);
        }

        query += ` ORDER BY s.nom, ue.libelle, m.nom`;

        const result = await db.query(query, params);

        // Calculer les statistiques
        let totalCout = 0;
        let totalHeures = 0;
        let totalNotes = 0;
        const etudiantsSet = new Set();

        const evaluations = result.rows.map(row => {
            totalCout += parseFloat(row.cout_total) || 0;
            totalHeures += (row.volume_horaire_cm || 0) + (row.volume_horaire_td || 0);
            totalNotes += parseInt(row.nombre_notes) || 0;
            
            return row;
        });

        res.json({
            evaluations: evaluations,
            statistiques: {
                total_matieres: evaluations.length,
                total_cout: Math.round(totalCout),
                total_heures: totalHeures,
                total_notes: totalNotes
            },
            groupe: evaluations.length > 0 ? {
                id: groupeId,
                nom: evaluations[0].groupe_nom,
                classe: evaluations[0].classe_nom,
                capacite: evaluations[0].capacite_max
            } : null
        });
    } catch (error) {
        console.error('Erreur dans getEvaluationsByGroupe:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};

// 2. Récupérer les détails d'une évaluation spécifique
exports.getEvaluationDetail = async (req, res) => {
    try {
        const { enseignementId } = req.params;

        const query = `
            SELECT 
                e.id as enseignement_id,
                e.groupe_id,
                e.annee_academique,
                e.created_at as date_chargement,
                
                m.id as matiere_id,
                m.nom as matiere_nom,
                m.coefficient,
                m.type_evaluation,
                m.volume_horaire_cm,
                m.taux_horaire_cm,
                m.volume_horaire_td,
                m.taux_horaire_td,
                m.updated_at as matiere_updated_at,
                
                p.id as professeur_id,
                p.nom as professeur_nom,
                p.prenom as professeur_prenom,
                p.statut as professeur_statut,
                p.date_creation as professeur_date_creation,
                
                ue.id as ue_id,
                ue.libelle as ue_nom,
                ue.maquette_id,
                
                s.id as semestre_id,
                s.nom as semestre_nom,
                
                g.nom as groupe_nom,
                g.capacite_max,
                
                cl.id as classe_id,
                cl.nom as classe_nom,
                cl.description as classe_description,
                
                (SELECT COUNT(*) FROM note WHERE enseignement_id = e.id) as nombre_notes,
                (SELECT COUNT(DISTINCT etudiant_id) FROM note WHERE enseignement_id = e.id) as nombre_etudiants,
                (SELECT COUNT(*) FROM etudiant WHERE groupe_id = e.groupe_id) as total_etudiants_groupe,
                
                (COALESCE(m.volume_horaire_cm, 0) * COALESCE(m.taux_horaire_cm, 0) +
                 COALESCE(m.volume_horaire_td, 0) * COALESCE(m.taux_horaire_td, 0)) as cout_total,
                 
                (COALESCE(m.volume_horaire_cm, 0) + COALESCE(m.volume_horaire_td, 0)) as volume_horaire_total
            FROM enseignement e
            INNER JOIN matiere m ON e.matiere_id = m.id
            INNER JOIN professeur p ON e.professeur_id = p.id
            LEFT JOIN ue ON m.ue_id = ue.id
            LEFT JOIN semestre s ON ue.semestre_id = s.id
            INNER JOIN groupe g ON e.groupe_id = g.id
            INNER JOIN classe cl ON g.classe_id = cl.id
            WHERE e.id = $1
        `;

        const result = await db.query(query, [enseignementId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Évaluation non trouvée' });
        }

        // Récupérer les notes associées - CORRIGÉ : prenoms au lieu de prenom
        const notesQuery = `
            SELECT 
                n.id,
                n.note1,
                n.note2,
                n.partiel,
                n.moyenne,
                n.coefficient,
                n.statut,
                n.created_at,
                et.id as etudiant_id,
                et.matricule,
                et.nom as etudiant_nom,
                et.prenoms as etudiant_prenoms
            FROM note n
            INNER JOIN etudiant et ON n.etudiant_id = et.id
            WHERE n.enseignement_id = $1
            ORDER BY et.nom, et.prenoms
        `;

        const notesResult = await db.query(notesQuery, [enseignementId]);

        res.json({
            evaluation: result.rows[0],
            notes: notesResult.rows,
            total_notes: notesResult.rows.length
        });
    } catch (error) {
        console.error('Erreur dans getEvaluationDetail:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};

// 3. Récupérer les statistiques d'évaluations par année académique
exports.getStatistiquesEvaluations = async (req, res) => {
    try {
        const { groupeId } = req.params;

        const query = `
            SELECT 
                e.annee_academique,
                COUNT(DISTINCT e.id) as nombre_matieres,
                COUNT(DISTINCT e.professeur_id) as nombre_professeurs,
                COUNT(DISTINCT n.id) as total_notes,
                COUNT(DISTINCT n.etudiant_id) as etudiants_evalues,
                SUM(COALESCE(m.volume_horaire_cm, 0) + COALESCE(m.volume_horaire_td, 0)) as heures_total,
                SUM(COALESCE(m.volume_horaire_cm, 0) * COALESCE(m.taux_horaire_cm, 0) +
                    COALESCE(m.volume_horaire_td, 0) * COALESCE(m.taux_horaire_td, 0)) as cout_total
            FROM enseignement e
            INNER JOIN matiere m ON e.matiere_id = m.id
            LEFT JOIN note n ON e.id = n.enseignement_id
            WHERE e.groupe_id = $1
            GROUP BY e.annee_academique
            ORDER BY e.annee_academique DESC
        `;

        const result = await db.query(query, [groupeId]);

        res.json({
            statistiques: result.rows
        });
    } catch (error) {
        console.error('Erreur dans getStatistiquesEvaluations:', error);
        res.status(500).json({ error: 'Erreur serveur' });
    }
};
// controllers/carte.controller.js
const db = require('../config/db.config');

// URL de base pour les photos
const PHOTO_BASE_URL = 'https://myiipea.ci';

/**
 * 1. Récupérer toutes les classes du département de l'utilisateur
 */
exports.getClasses = async (req, res) => {
    const client = await db.connect();
    
    try {
        const departement_id = req.user?.departement_id;
        
        const query = `
            SELECT DISTINCT
                c.id,
                c.nom,
                c.description,
                COUNT(DISTINCT g.id) as nombre_groupes
            FROM classe c
            LEFT JOIN groupe g ON g.classe_id = c.id
            LEFT JOIN etudiant e ON e.groupe_id = g.id
            WHERE e.site_id = $1 OR $1 IS NULL
            GROUP BY c.id, c.nom, c.description
            ORDER BY c.nom
        `;
        
        const result = await client.query(query, [departement_id]);
        
        res.status(200).json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching classes:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des classes: ' + error.message
        });
    } finally {
        client.release();
    }
};

/**
 * 2. Récupérer les groupes d'une classe spécifique
 */
exports.getGroupesByClasse = async (req, res) => {
    const client = await db.connect();
    
    try {
        const { classe_id } = req.params;
        const departement_id = req.user?.departement_id;
        
        const query = `
            SELECT 
                g.id,
                g.nom,
                g.capacite_max,
                COUNT(e.id) as effectif_actuel
            FROM groupe g
            LEFT JOIN etudiant e ON e.groupe_id = g.id AND e.site_id = $2
            WHERE g.classe_id = $1
            GROUP BY g.id, g.nom, g.capacite_max
            ORDER BY g.nom
        `;
        
        const result = await client.query(query, [classe_id, departement_id]);
        
        res.status(200).json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching groupes:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des groupes: ' + error.message
        });
    } finally {
        client.release();
    }
};

/**
 * 3. Récupérer les étudiants d'un groupe spécifique
 */
exports.getEtudiantsByGroupe = async (req, res) => {
    const client = await db.connect();
    
    try {
        const { groupe_id } = req.params;
        const annee_academique_id = req.query.annee_id || null;
        const departement_id = req.user?.departement_id;
        
        // Infos du groupe et de la classe
        const infosQuery = `
            SELECT 
                g.id as groupe_id,
                g.nom as groupe_nom,
                c.id as classe_id,
                c.nom as classe_nom,
                c.description as classe_description,
                COUNT(e.id) as effectif_total
            FROM groupe g
            JOIN classe c ON c.id = g.classe_id
            LEFT JOIN etudiant e ON e.groupe_id = g.id AND e.site_id = $2
            WHERE g.id = $1
            GROUP BY g.id, g.nom, c.id, c.nom, c.description
        `;
        
        const infosResult = await client.query(infosQuery, [groupe_id, departement_id]);
        
        // Liste des étudiants - URL complète pour la photo
        let etudiantsQuery = `
            SELECT 
                e.id,
                e.matricule_iipea,
                e.nom,
                e.prenoms,
                e.sexe,
                e.date_naissance,
                e.lieu_naissance,
                e.telephone,
                e.email,
                e.photo_url,
                CASE 
                    WHEN e.photo_url IS NOT NULL AND e.photo_url != '' 
                    THEN CONCAT('${PHOTO_BASE_URL}', e.photo_url)
                    ELSE NULL 
                END as photo_path,
                e.statut_scolaire,
                COALESCE(f.nom, 'Non défini') as filiere,
                COALESCE(n.libelle, 'Non défini') as niveau,
                COALESCE(curs.type_parcours, 'Non défini') as parcours,
                COALESCE(aa.annee, 'Non défini') as annee_academique
            FROM etudiant e
            LEFT JOIN filiere f ON e.id_filiere = f.id
            LEFT JOIN niveau n ON e.niveau_id = n.id
            LEFT JOIN curcus curs ON e.curcus_id = curs.id
            LEFT JOIN anneeacademique aa ON e.annee_academique_id = aa.id
            WHERE e.groupe_id = $1
            AND e.site_id = $2
        `;
        
        const params = [groupe_id, departement_id];
        
        if (annee_academique_id) {
            etudiantsQuery += ` AND e.annee_academique_id = $3`;
            params.push(annee_academique_id);
        }
        
        etudiantsQuery += ` ORDER BY e.nom, e.prenoms`;
        
        const etudiantsResult = await client.query(etudiantsQuery, params);
        
        res.status(200).json({
            success: true,
            data: {
                groupe_info: infosResult.rows[0] || null,
                etudiants: etudiantsResult.rows,
                total: etudiantsResult.rowCount
            }
        });
    } catch (error) {
        console.error('Error fetching etudiants:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des étudiants: ' + error.message
        });
    } finally {
        client.release();
    }
};

/**
 * 4. Récupérer les années académiques du département
 */
exports.getAnneesAcademiques = async (req, res) => {
    const client = await db.connect();
    
    try {
        const departement_id = req.user?.departement_id;
        
        const query = `
            SELECT
                a.id,
                a.annee,
                s.etat
            FROM anneeacademique a
            JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
            WHERE s.site_id = $1
            ORDER BY
                CASE WHEN s.etat = 'en cour' THEN 0 ELSE 1 END,
                a.annee DESC
        `;

        const result = await client.query(query, [departement_id]);
        
        res.status(200).json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching annees:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des années académiques: ' + error.message
        });
    } finally {
        client.release();
    }
};

/**
 * 5. Détails d'un étudiant
 */
exports.getEtudiantDetails = async (req, res) => {
    const client = await db.connect();
    
    try {
        const { etudiant_id } = req.params;
        const departement_id = req.user?.departement_id;
        
        const query = `
            SELECT 
                e.id,
                e.matricule_iipea,
                e.nom,
                e.prenoms,
                e.sexe,
                e.date_naissance,
                e.lieu_naissance,
                e.telephone,
                e.email,
                e.photo_url,
                CASE 
                    WHEN e.photo_url IS NOT NULL AND e.photo_url != '' 
                    THEN CONCAT('${PHOTO_BASE_URL}', e.photo_url)
                    ELSE NULL 
                END as photo_path,
                e.statut_scolaire,
                COALESCE(f.nom, 'Non défini') as filiere,
                COALESCE(n.libelle, 'Non défini') as niveau,
                COALESCE(curs.type_parcours, 'Non défini') as parcours,
                COALESCE(aa.annee, 'Non défini') as annee_academique
            FROM etudiant e
            LEFT JOIN filiere f ON e.id_filiere = f.id
            LEFT JOIN niveau n ON e.niveau_id = n.id
            LEFT JOIN curcus curs ON e.curcus_id = curs.id
            LEFT JOIN anneeacademique aa ON e.annee_academique_id = aa.id
            WHERE e.id = $1 AND e.site_id = $2
        `;
        
        const result = await client.query(query, [etudiant_id, departement_id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Étudiant non trouvé'
            });
        }
        
        res.status(200).json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching etudiant details:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la récupération des détails: ' + error.message
        });
    } finally {
        client.release();
    }
};

/**
 * 6. Données initiales (classes + années avec année en cour par défaut)
 */
exports.getCarteInitialData = async (req, res) => {
    const client = await db.connect();
    
    try {
        const departement_id = req.user?.departement_id;
        
        const classesQuery = `
            SELECT DISTINCT
                c.id, 
                c.nom, 
                c.description,
                COUNT(DISTINCT g.id) as nombre_groupes
            FROM classe c
            LEFT JOIN groupe g ON g.classe_id = c.id
            LEFT JOIN etudiant e ON e.groupe_id = g.id
            WHERE e.site_id = $1
            GROUP BY c.id, c.nom, c.description
            ORDER BY c.nom
        `;

        const classesResult = await client.query(classesQuery, [departement_id]);
        
        const anneesQuery = `
            SELECT a.id, a.annee, s.etat
            FROM anneeacademique a
            JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
            WHERE s.site_id = $1
            ORDER BY
                CASE WHEN s.etat = 'en cour' THEN 0 ELSE 1 END,
                a.annee DESC
        `;

        const anneesResult = await client.query(anneesQuery, [departement_id]);
        
        res.status(200).json({
            success: true,
            data: {
                classes: classesResult.rows,
                annees_academiques: anneesResult.rows
            }
        });
    } catch (error) {
        console.error('Error in getCarteInitialData:', error);
        res.status(500).json({
            success: false,
            message: 'Erreur lors du chargement initial: ' + error.message
        });
    } finally {
        client.release();
    }
};

console.log('✅ Controller carte.controller.js chargé avec succès');
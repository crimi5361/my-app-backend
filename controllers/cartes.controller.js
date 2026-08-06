// controllers/carte.controller.js
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

// URL de base pour les photos
const PHOTO_BASE_URL = 'https://myiipea.ci';

/**
 * 1. Récupérer toutes les classes du département de l'utilisateur
 */
exports.getClasses = async (req, res) => {
    const client = await db.connect();
    
    try {
        const departement_id = req.user?.departement_id;
        const ecoleId = getEcoleScopeFromUser(req);

        // Chantier 6 (2026-08-01) : une classe doit rester sélectionnable pour la génération de
        // cartes même avant tout découpage en groupes — mêmes deux branches (groupés inchangé +
        // sans groupe correspondant aux critères, nouveau/additif) que dans classes.controller.js.
        // Chantier 3 (2026-08-01) : cloisonnement par école, cumulatif avec le filtre site ($1) —
        // c.filiere_id est une propriété directe de la classe, pas besoin de jointure.
        const query = `
            SELECT DISTINCT
                c.id,
                c.nom,
                c.description,
                (SELECT COUNT(DISTINCT g3.id) FROM groupe g3 WHERE g3.classe_id = c.id) as nombre_groupes
            FROM classe c
            WHERE (
              $1::int IS NULL
              OR EXISTS (
                SELECT 1 FROM etudiant e2
                JOIN groupe g2 ON g2.id = e2.groupe_id
                WHERE g2.classe_id = c.id AND e2.site_id = $1
              )
              OR EXISTS (
                SELECT 1 FROM etudiant e2b
                WHERE e2b.groupe_id IS NULL
                  AND e2b.id_filiere = c.filiere_id AND e2b.niveau_id = c.niveau_id
                  AND e2b.annee_academique_id = c.annee_academique_id
                  AND e2b.curcus_id IS NOT DISTINCT FROM c.curcus_id AND e2b.site_id = $1
              )
            )
            AND ($2::int IS NULL OR c.filiere_id IN (SELECT id FROM filiere WHERE departement_id IN (SELECT id FROM departement WHERE ecole_id = $2)))
            ORDER BY c.nom
        `;

        const result = await client.query(query, [departement_id, ecoleId]);
        
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
        const ecoleId = getEcoleScopeFromUser(req);

        // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (e.site_id) existant.
        const query = `
            SELECT
                g.id,
                g.nom,
                g.capacite_max,
                COUNT(e.id) as effectif_actuel
            FROM groupe g
            LEFT JOIN etudiant e ON e.groupe_id = g.id AND e.site_id = $2
            WHERE g.classe_id = $1
              AND ($3::int IS NULL OR EXISTS (
                SELECT 1 FROM classe c2 JOIN filiere f2 ON f2.id = c2.filiere_id
                WHERE c2.id = g.classe_id AND f2.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)
              ))
            GROUP BY g.id, g.nom, g.capacite_max
            ORDER BY g.nom
        `;

        const result = await client.query(query, [classe_id, departement_id, ecoleId]);
        
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
        const ecoleId = getEcoleScopeFromUser(req);

        // Infos du groupe et de la classe. Cloisonnement par école (Chantier 3) — cumulatif avec
        // le filtre site (e.site_id) existant, via la filière de la classe.
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
              AND ($3::int IS NULL OR c.filiere_id IN (SELECT id FROM filiere WHERE departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)))
            GROUP BY g.id, g.nom, c.id, c.nom, c.description
        `;

        const infosResult = await client.query(infosQuery, [groupe_id, departement_id, ecoleId]);
        
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

        // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (e.site_id) existant.
        if (ecoleId !== null) {
            etudiantsQuery += ` AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $${params.length + 1})`;
            params.push(ecoleId);
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
        const ecoleId = getEcoleScopeFromUser(req);

        // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (e.site_id) existant.
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
              AND ($3::int IS NULL OR f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))
        `;

        const result = await client.query(query, [etudiant_id, departement_id, ecoleId]);
        
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
        const ecoleId = getEcoleScopeFromUser(req);

        // Chantier 6 : même correctif que getClasses ci-dessus. Chantier 3 : cloisonnement par
        // école, cumulatif avec le filtre site ($1).
        const classesQuery = `
            SELECT DISTINCT
                c.id,
                c.nom,
                c.description,
                (SELECT COUNT(DISTINCT g3.id) FROM groupe g3 WHERE g3.classe_id = c.id) as nombre_groupes
            FROM classe c
            WHERE (
              EXISTS (
                SELECT 1 FROM etudiant e2
                JOIN groupe g2 ON g2.id = e2.groupe_id
                WHERE g2.classe_id = c.id AND e2.site_id = $1
              )
              OR EXISTS (
                SELECT 1 FROM etudiant e2b
                WHERE e2b.groupe_id IS NULL
                  AND e2b.id_filiere = c.filiere_id AND e2b.niveau_id = c.niveau_id
                  AND e2b.annee_academique_id = c.annee_academique_id
                  AND e2b.curcus_id IS NOT DISTINCT FROM c.curcus_id AND e2b.site_id = $1
              )
            )
            AND ($2::int IS NULL OR c.filiere_id IN (SELECT id FROM filiere WHERE departement_id IN (SELECT id FROM departement WHERE ecole_id = $2)))
            ORDER BY c.nom
        `;

        const classesResult = await client.query(classesQuery, [departement_id, ecoleId]);
        
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
const db = require('../config/db.config');

// ✅ Correctif Chantier Statistiques (2026-08-18) : `total`/`total_etudiants` comptaient TOUS les
// étudiants positionnés sur l'année (admissions/réinscriptions encore en attente de paiement
// comprises), alors que la colonne voisine `inscriptions` était déjà correctement filtrée par
// `standing = 'Inscrit'`. Toutes les requêtes ci-dessous filtrent désormais sur ce même standing —
// un étudiant en attente de paiement n'est officiellement inscrit nulle part sur cette page.
//
// ✅ Toutes les requêtes ci-dessous sourcent vue_position_academique (pas `etudiant` directement)
// pour déterminer QUI apparaît dans le tableau (une ligne par niveau/cycle/cursus/filière avec au
// moins un inscrit) et pour `etudiants_affectes`/`etudiants_non_affectes` (statut_scolaire ACTUEL) :
// etudiant.annee_academique_id n'est qu'une position COURANTE, écrasée à chaque réinscription — un
// étudiant réinscrit vers l'année suivante ne doit pas disparaître rétroactivement des statistiques
// de l'année qu'il vient de quitter.
//
// ✅✅ Correctif "Inscriptions vs Ré-inscriptions" (2026-09-09, v2 — remplace le correctif v1 du même
// jour qui ne corrigeait QUE `reinscriptions`, laissant `inscriptions`/`total` sur l'ancienne
// définition "tout inscrit standing='Inscrit'" : les deux colonnes se chevauchaient donc toujours,
// un réinscrit validé restant AUSSI compté dans `inscriptions`, faussant `total`).
//
// ANCIENNE RÈGLE (retirée, ne sert plus à distinguer inscription/réinscription dans ce fichier) :
// une constante NIVEAUX_IMPLIQUANT_REINSCRIPTION listait les niveaux "de progression" (LICENCE 2/3,
// LICENCE 2/3 PRO, BTS 2) et un étudiant positionné sur l'un d'eux était automatiquement classé
// "réinscrit" — hérité d'une époque où la distinction admission/réinscription n'était pas encore
// fiablement tracée. Incorrecte pour les statistiques actuelles : un étudiant en LICENCE 2 peut être
// une admission fraîche (transfert, équivalence...) tout comme une progression réinscrite — le
// niveau SEUL ne permet jamais de trancher.
//
// NOUVELLE RÈGLE : `historique_inscription.type_evenement` est la vraie trace métier, écrite
// UNIQUEMENT à la finalisation du paiement en caisse (jamais un dossier en attente), sur deux
// chemins mutuellement exclusifs et déjà existants — jamais les deux pour le même événement :
//   - 'admission'     : controllers/caisse.controller.js::validerPaiementAdmission (~ligne 1545) ET
//                       controllers/paiyement.controller.js::createPaiement (~ligne 248, commentaire
//                       explicite : "cet endpoint ... ne traite jamais une réinscription").
//   - 'reinscription' : controllers/caisse.controller.js::validerPaiementReinscription (~ligne 495).
// Même définition déjà validée et utilisée ailleurs (services/statistiquesInscriptions.service.js
// ::getInscriptionsValidees, consommée par les dashboards) — reprise et déclinée ici par niveau /
// cycle / cursus / filière via 2 CTE (une par type d'événement, agrégées UNE fois), jamais une
// sous-requête corrélée répétée par ligne.
//
// `total` = `inscriptions` + `reinscriptions` (somme arithmétique explicite, plus jamais un second
// COUNT(*) indépendant) : les deux populations sont désormais structurellement disjointes (une ligne
// historique_inscription ne porte qu'UNE seule valeur de type_evenement), leur somme est donc
// mathématiquement le total exact, sans double-comptage possible.
//
// Limite connue (transparente, pas une régression introduite ici) : `etudiants_affectes` /
// `etudiants_non_affectes` restent sourcés de vue_position_academique (position ACTUELLE), une
// population qui peut légèrement différer de `inscriptions + reinscriptions` (historique_inscription)
// dans deux cas rares : (1) admission validée AVANT le correctif du 2026-08-18 qui a fait écrire
// historique_inscription à paiyement.controller.js — gap historique déjà documenté dans
// statistiquesInscriptions.service.js, non reconstituable ; (2) un dossier validé par le module
// Équivalence (controllers/equivalence.controller.js::validerDemande) n'écrit à ce jour AUCUNE ligne
// historique_inscription (vérifié — seule sa propre table demande_equivalence_historique est
// alimentée), donc un étudiant admis par équivalence n'apparaît pour l'instant dans aucune des deux
// colonnes Inscriptions/Ré-inscriptions bien qu'il soit bien compté dans Affectés/Non Affectés. Sur
// les données réelles testées (année courante, aucun gap ni équivalence encore validée), les deux
// populations coïncident exactement.

// Statistiques par cycles (Type de filière)
exports.getStatisticsByCycle = async (req, res) => {
    try {
        const { annee_academique_id, departement_id } = req.query;

        const query = `
            WITH admissions_validees AS (
                SELECT hf.type_filiere_id AS cycle_id, COUNT(*) AS total
                FROM historique_inscription h
                JOIN etudiant he ON he.id = h.etudiant_id
                JOIN niveau hn ON hn.id = h.niveau_id
                JOIN filiere hf ON hf.id = hn.filiere_id
                WHERE h.type_evenement = 'admission' AND h.annee_academique_id = $1 AND he.site_id = $2
                GROUP BY hf.type_filiere_id
            ),
            reinscriptions_validees AS (
                SELECT hf.type_filiere_id AS cycle_id, COUNT(*) AS total
                FROM historique_inscription h
                JOIN etudiant he ON he.id = h.etudiant_id
                JOIN niveau hn ON hn.id = h.niveau_id
                JOIN filiere hf ON hf.id = hn.filiere_id
                WHERE h.type_evenement = 'reinscription' AND h.annee_academique_id = $1 AND he.site_id = $2
                GROUP BY hf.type_filiere_id
            )
            SELECT
                tf.id as cycle_id,
                tf.libelle as cycle,
                COUNT(CASE WHEN e.statut_scolaire = 'Affecté' THEN 1 END) as etudiants_affectes,
                COUNT(CASE WHEN e.statut_scolaire = 'Non affecté' THEN 1 END) as etudiants_non_affectes,
                COALESCE(MAX(av.total), 0) as inscriptions,
                COALESCE(MAX(rv.total), 0) as reinscriptions,
                COALESCE(MAX(av.total), 0) + COALESCE(MAX(rv.total), 0) as total
            FROM vue_position_academique e
            INNER JOIN niveau n ON e.niveau_id = n.id
            INNER JOIN filiere f ON n.filiere_id = f.id
            INNER JOIN typefiliere tf ON f.type_filiere_id = tf.id
            LEFT JOIN admissions_validees av ON av.cycle_id = tf.id
            LEFT JOIN reinscriptions_validees rv ON rv.cycle_id = tf.id
            WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
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

        const query = `
            WITH admissions_validees AS (
                SELECT hn.libelle AS niveau, COUNT(*) AS total
                FROM historique_inscription h
                JOIN etudiant he ON he.id = h.etudiant_id
                JOIN niveau hn ON hn.id = h.niveau_id
                WHERE h.type_evenement = 'admission' AND h.annee_academique_id = $1 AND he.site_id = $2
                GROUP BY hn.libelle
            ),
            reinscriptions_validees AS (
                SELECT hn.libelle AS niveau, COUNT(*) AS total
                FROM historique_inscription h
                JOIN etudiant he ON he.id = h.etudiant_id
                JOIN niveau hn ON hn.id = h.niveau_id
                WHERE h.type_evenement = 'reinscription' AND h.annee_academique_id = $1 AND he.site_id = $2
                GROUP BY hn.libelle
            )
            SELECT
                n.libelle as niveau,
                COUNT(CASE WHEN e.statut_scolaire = 'Affecté' THEN 1 END) as etudiants_affectes,
                COUNT(CASE WHEN e.statut_scolaire = 'Non affecté' THEN 1 END) as etudiants_non_affectes,
                COALESCE(MAX(av.total), 0) as inscriptions,
                COALESCE(MAX(rv.total), 0) as reinscriptions,
                COALESCE(MAX(av.total), 0) + COALESCE(MAX(rv.total), 0) as total
            FROM vue_position_academique e
            INNER JOIN niveau n ON e.niveau_id = n.id
            LEFT JOIN admissions_validees av ON av.niveau = n.libelle
            LEFT JOIN reinscriptions_validees rv ON rv.niveau = n.libelle
            WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
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

        const query = `
            WITH admissions_validees AS (
                SELECT h.curcus_id, COUNT(*) AS total
                FROM historique_inscription h
                JOIN etudiant he ON he.id = h.etudiant_id
                WHERE h.type_evenement = 'admission' AND h.annee_academique_id = $1 AND he.site_id = $2
                GROUP BY h.curcus_id
            ),
            reinscriptions_validees AS (
                SELECT h.curcus_id, COUNT(*) AS total
                FROM historique_inscription h
                JOIN etudiant he ON he.id = h.etudiant_id
                WHERE h.type_evenement = 'reinscription' AND h.annee_academique_id = $1 AND he.site_id = $2
                GROUP BY h.curcus_id
            )
            SELECT
                c.id as cursus_id,
                c.type_parcours as cursus,
                COUNT(CASE WHEN e.statut_scolaire = 'Affecté' THEN 1 END) as etudiants_affectes,
                COUNT(CASE WHEN e.statut_scolaire = 'Non affecté' THEN 1 END) as etudiants_non_affectes,
                COALESCE(MAX(av.total), 0) as inscriptions,
                COALESCE(MAX(rv.total), 0) as reinscriptions,
                COALESCE(MAX(av.total), 0) + COALESCE(MAX(rv.total), 0) as total
            FROM vue_position_academique e
            INNER JOIN niveau n ON e.niveau_id = n.id
            INNER JOIN curcus c ON e.curcus_id = c.id
            LEFT JOIN admissions_validees av ON av.curcus_id = c.id
            LEFT JOIN reinscriptions_validees rv ON rv.curcus_id = c.id
            WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
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

        const query = `
            WITH admissions_validees AS (
                SELECT h.niveau_id, COUNT(*) AS total
                FROM historique_inscription h
                JOIN etudiant he ON he.id = h.etudiant_id
                WHERE h.type_evenement = 'admission' AND h.annee_academique_id = $1 AND he.site_id = $2
                GROUP BY h.niveau_id
            ),
            reinscriptions_validees AS (
                SELECT h.niveau_id, COUNT(*) AS total
                FROM historique_inscription h
                JOIN etudiant he ON he.id = h.etudiant_id
                WHERE h.type_evenement = 'reinscription' AND h.annee_academique_id = $1 AND he.site_id = $2
                GROUP BY h.niveau_id
            )
            SELECT
                f.id as filiere_id,
                f.nom as filiere,
                f.sigle,
                tf.libelle as type_filiere,
                n.libelle as niveau,
                COUNT(CASE WHEN e.statut_scolaire = 'Affecté' THEN 1 END) as etudiants_affectes,
                COUNT(CASE WHEN e.statut_scolaire = 'Non affecté' THEN 1 END) as etudiants_non_affectes,
                COALESCE(MAX(av.total), 0) as inscriptions,
                COALESCE(MAX(rv.total), 0) as reinscriptions,
                COALESCE(MAX(av.total), 0) + COALESCE(MAX(rv.total), 0) as total
            FROM vue_position_academique e
            INNER JOIN niveau n ON e.niveau_id = n.id
            INNER JOIN filiere f ON n.filiere_id = f.id
            INNER JOIN typefiliere tf ON f.type_filiere_id = tf.id
            LEFT JOIN admissions_validees av ON av.niveau_id = n.id
            LEFT JOIN reinscriptions_validees rv ON rv.niveau_id = n.id
            WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
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

// Statistiques détaillées combinées — total_etudiants (KPI "Étudiants inscrits") reste sourcé de
// vue_position_academique : c'est un effectif ACTUEL (qui est inscrit aujourd'hui), une question
// différente de "par quel parcours a-t-il été inscrit" (Inscriptions/Ré-inscriptions ci-dessus) —
// non concerné par ce correctif, inchangé.
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
                FROM vue_position_academique e
                INNER JOIN niveau n ON e.niveau_id = n.id
                INNER JOIN filiere f ON n.filiere_id = f.id
                INNER JOIN typefiliere tf ON f.type_filiere_id = tf.id
                WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
                GROUP BY tf.libelle
            `, [annee_academique_id, departement_id]),

            db.query(`
                SELECT n.libelle as niveau, COUNT(*) as total
                FROM vue_position_academique e
                INNER JOIN niveau n ON e.niveau_id = n.id
                WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
                GROUP BY n.libelle
            `, [annee_academique_id, departement_id]),

            db.query(`
                SELECT c.type_parcours as cursus, COUNT(*) as total
                FROM vue_position_academique e
                INNER JOIN curcus c ON e.curcus_id = c.id
                WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
                GROUP BY c.type_parcours
            `, [annee_academique_id, departement_id]),

            db.query(`
                SELECT f.nom as filiere, COUNT(*) as total
                FROM vue_position_academique e
                INNER JOIN niveau n ON e.niveau_id = n.id
                INNER JOIN filiere f ON n.filiere_id = f.id
                WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit'
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

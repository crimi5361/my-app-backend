const db = require('../config/db.config');

exports.getStatsInscriptions = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const departementId = req.user.departement_id;
    const anneeAcademiqueId = req.query.anneeAcademiqueId || await getAnneeAcademiqueCourante();

    let dateCondition = '';
    let dateParams = [anneeAcademiqueId, departementId];
    
    if (startDate && endDate) {
      dateCondition = 'AND DATE(e.date_inscription) BETWEEN $3 AND $4';
      dateParams.push(startDate, endDate);
    }

    // 1. Nombre total d'étudiants inscrits
    const nbEtudiants = await db.query(`
      SELECT COUNT(*) AS total
      FROM etudiant e
      WHERE e.annee_academique_id = $1 
        AND e.departement_id = $2 
        AND e.standing = 'Inscrit'
        ${dateCondition}
    `, dateParams);

    // 2. Inscriptions aujourd'hui
    const aujourdhui = await db.query(`
      SELECT COUNT(*) AS total
      FROM etudiant e
      WHERE e.annee_academique_id = $1 
        AND e.departement_id = $2 
        AND DATE(e.date_inscription) = CURRENT_DATE
    `, [anneeAcademiqueId, departementId]);

    // 3. Étudiants en attente
    const enAttente = await db.query(`
      SELECT COUNT(*) AS total
      FROM etudiant e
      WHERE e.annee_academique_id = $1 
        AND e.departement_id = $2 
        AND e.standing = 'en attente'  
        ${dateCondition}
    `, dateParams);

    // 4. Confirmés aujourd'hui
    const confirmesAujourdhui = await db.query(`
      SELECT COUNT(*) AS total
      FROM etudiant e
      WHERE e.annee_academique_id = $1 
        AND e.departement_id = $2 
        AND e.standing = 'Inscrit'
        AND DATE(e.date_inscription) = CURRENT_DATE
    `, [anneeAcademiqueId, departementId]);

    // 5. Inscriptions par utilisateur
    const inscriptionsParUtilisateur = await db.query(`
      SELECT 
        u.id AS utilisateur_id,
        u.nom AS utilisateur_nom,
        u.email AS utilisateur_email,
        COUNT(e.id) AS total_inscrits,
        SUM(CASE WHEN e.standing = 'en attente' THEN 1 ELSE 0 END) AS en_attente,  
        SUM(CASE WHEN e.standing = 'Inscrit' THEN 1 ELSE 0 END) AS confirmes
      FROM utilisateur u
      LEFT JOIN etudiant e ON u.id = e.inscrit_par::integer
      WHERE e.annee_academique_id = $1 
        AND e.departement_id = $2
        ${startDate && endDate ? 'AND DATE(e.date_inscription) BETWEEN $3 AND $4' : ''}
      GROUP BY u.id, u.nom, u.email
      ORDER BY total_inscrits DESC
    `, dateParams);

    // 6. Inscriptions journalières
    const inscriptionsJournalieres = await db.query(`
      SELECT 
        DATE(date_inscription) AS date,
        COUNT(*) AS nombre_inscriptions,
        SUM(CASE WHEN standing = 'Inscrit' THEN 1 ELSE 0 END) AS confirmes
      FROM etudiant
      WHERE annee_academique_id = $1 
        AND departement_id = $2
        ${startDate && endDate ? 'AND DATE(date_inscription) BETWEEN $3 AND $4' : ''}
      GROUP BY DATE(date_inscription)
      ORDER BY date DESC
    `, dateParams);

    // 7. Statistiques par statut
    const statsParStatut = await db.query(`
      SELECT 
        statut_scolaire,
        COUNT(*) AS nombre
      FROM etudiant
      WHERE annee_academique_id = $1 
        AND departement_id = $2
        ${startDate && endDate ? 'AND DATE(date_inscription) BETWEEN $3 AND $4' : ''}
      GROUP BY statut_scolaire
      ORDER BY nombre DESC
    `, dateParams);

    // 8. NOUVEAU : Paiements par utilisateur (SIMPLIFIÉ)
    const paiementsParUtilisateur = await db.query(`
      SELECT 
        u.id AS utilisateur_id,
        u.nom AS utilisateur_nom,
        u.email AS utilisateur_email,
        COUNT(p.id) AS nombre_paiements
      FROM utilisateur u
      LEFT JOIN paiement p ON u.id::varchar = p.effectue_par
      LEFT JOIN etudiant e ON p.etudiant_id = e.id
      WHERE p.id IS NOT NULL
        AND e.annee_academique_id = $1
        AND e.departement_id = $2
        ${startDate && endDate ? 'AND DATE(p.date_paiement) BETWEEN $3 AND $4' : ''}
      GROUP BY u.id, u.nom, u.email
      ORDER BY nombre_paiements DESC
    `, dateParams);

    // 9. NOUVEAU : Total des paiements (SIMPLIFIÉ)
    const totalPaiements = await db.query(`
      SELECT COUNT(p.id) AS nombre_total_paiements
      FROM paiement p
      JOIN etudiant e ON p.etudiant_id = e.id
      WHERE e.annee_academique_id = $1
        AND e.departement_id = $2
        ${startDate && endDate ? 'AND DATE(p.date_paiement) BETWEEN $3 AND $4' : ''}
    `, dateParams);

    res.json({
      totalEtudiants: parseInt(nbEtudiants.rows[0].total),
      inscriptionsAujourdhui: parseInt(aujourdhui.rows[0].total),
      enAttente: parseInt(enAttente.rows[0].total),
      confirmesAujourdhui: parseInt(confirmesAujourdhui.rows[0].total),
      inscriptionsParUtilisateur: inscriptionsParUtilisateur.rows,
      inscriptionsJournalieres: inscriptionsJournalieres.rows,
      statsParStatut: statsParStatut.rows,
      
      // Nouvelles données de paiements (TRÈS SIMPLIFIÉES)
      paiementsParUtilisateur: paiementsParUtilisateur.rows,
      nombreTotalPaiements: parseInt(totalPaiements.rows[0]?.nombre_total_paiements || 0),
      
      periode: {
        startDate: startDate || null,
        endDate: endDate || null,
        anneeAcademique: anneeAcademiqueId
      }
    });

  } catch (error) {
    console.error('Erreur stats inscriptions:', error);
    res.status(500).json({ 
      error: 'Erreur serveur lors de la récupération des statistiques',
      details: error.message 
    });
  }
};

// Fonction utilitaire pour obtenir l'année académique courante
async function getAnneeAcademiqueCourante() {
  try {
    const result = await db.query(`
      SELECT id FROM anneeacademique WHERE etat = 'en cour' LIMIT 1
    `);
    return result.rows[0]?.id;
  } catch (error) {
    console.error('Erreur récupération année académique:', error);
    return null;
  }
}

// Optionnel : Méthode pour les stats détaillées par période
exports.getStatsDetaillees = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const departementId = req.user.departement_id;
    const anneeAcademiqueId = req.query.anneeAcademiqueId || await getAnneeAcademiqueCourante();

    const params = [anneeAcademiqueId, departementId];
    let dateCondition = '';

    if (startDate && endDate) {
      dateCondition = 'AND DATE(date_inscription) BETWEEN $3 AND $4';
      params.push(startDate, endDate);
    }

    const result = await db.query(`
      SELECT 
        -- Par statut
        COUNT(*) FILTER (WHERE standing = 'Inscrit') AS total_inscrits,
        COUNT(*) FILTER (WHERE standing = 'en attente') AS total_attente,
        
        -- Par genre
        COUNT(*) FILTER (WHERE sexe = 'M') AS hommes,
        COUNT(*) FILTER (WHERE sexe = 'F') AS femmes,
        
        -- Par période
        COUNT(*) FILTER (WHERE DATE(date_inscription) = CURRENT_DATE) AS aujourdhui,
        COUNT(*) FILTER (WHERE DATE(date_inscription) = CURRENT_DATE - INTERVAL '1 day') AS hier
        
      FROM etudiant
      WHERE annee_academique_id = $1 
        AND departement_id = $2
        ${dateCondition}
    `, params);

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Erreur stats détaillées:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
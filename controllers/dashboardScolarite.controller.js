// Dashboard Scolarité (Chantier 2, 2026-08-02) — vue académique uniquement, jamais de donnée
// financière (contrairement à StatDashboard.controller.js) : contrôleur dédié, conforme à la
// maquette validée le 2026-08-01. Cloisonnement par site (req.user.departement_id) et par école
// (getEcoleScopeFromUser, Chantier 3), cumulatifs.
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

exports.getDashboardScolarite = async (req, res) => {
  try {
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site, appliqué uniquement
    // si l'agent est restreint. Fragment vide si ecoleId === null : comportement inchangé.
    const ecoleCond = ecoleId !== null
      ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3)'
      : '';
    const baseParams = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];

    const [
      totalInscrits,
      aujourdhui,
      hier,
      cetteSemaine,
      semaineDerniere,
      origineResult,
      evolutionResult,
      parEcoleResult,
      parNiveauResult,
      parFiliereResult,
      activiteAgentsResult,
    ] = await Promise.all([
      db.query(`
        SELECT COUNT(*) AS total FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COUNT(*) AS total FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.date_inscription::date = CURRENT_DATE ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COUNT(*) AS total FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.date_inscription::date = CURRENT_DATE - INTERVAL '1 day' ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COUNT(*) AS total FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2
          AND e.date_inscription::date >= date_trunc('week', CURRENT_DATE) ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COUNT(*) AS total FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2
          AND e.date_inscription::date >= date_trunc('week', CURRENT_DATE) - INTERVAL '7 days'
          AND e.date_inscription::date < date_trunc('week', CURRENT_DATE) ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COALESCE(e.source_inscription, 'agent') AS source, COUNT(*) AS total FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCond}
        GROUP BY COALESCE(e.source_inscription, 'agent')
      `, baseParams),

      db.query(`
        SELECT e.date_inscription::date AS jour, COUNT(*) AS total FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2
          AND e.date_inscription::date BETWEEN CURRENT_DATE - INTERVAL '13 days' AND CURRENT_DATE ${ecoleCond}
        GROUP BY e.date_inscription::date ORDER BY jour
      `, baseParams),

      db.query(`
        SELECT ec.nom AS ecole, COUNT(*) AS total
        FROM vue_position_academique e
        JOIN filiere f ON f.id = e.id_filiere
        JOIN departement d ON d.id = f.departement_id
        JOIN ecole ec ON ec.id = d.ecole_id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCond}
        GROUP BY ec.nom ORDER BY total DESC
      `, baseParams),

      db.query(`
        SELECT n.libelle AS niveau, COUNT(*) AS total
        FROM vue_position_academique e
        JOIN niveau n ON n.id = e.niveau_id
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCond}
        GROUP BY n.libelle ORDER BY total DESC
      `, baseParams),

      db.query(`
        SELECT f.nom AS filiere, COUNT(*) AS total
        FROM vue_position_academique e
        JOIN filiere f ON f.id = e.id_filiere
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCond}
        GROUP BY f.nom ORDER BY total DESC LIMIT 5
      `, baseParams),

      // Activité des agents — même principe que StatsInscriptions.controller.js (jointure
      // utilisateur/etudiant.inscrit_par). Tendance : 15 derniers jours vs 15 jours précédents.
      db.query(`
        SELECT
          u.nom AS agent,
          COUNT(*) FILTER (WHERE e.date_inscription::date >= CURRENT_DATE - INTERVAL '29 days') AS total_30j,
          COUNT(*) FILTER (WHERE e.date_inscription::date >= CURRENT_DATE - INTERVAL '14 days') AS total_15j_recent,
          COUNT(*) FILTER (WHERE e.date_inscription::date >= CURRENT_DATE - INTERVAL '29 days'
                             AND e.date_inscription::date < CURRENT_DATE - INTERVAL '14 days') AS total_15j_precedent
        FROM vue_position_academique e
        JOIN utilisateur u ON u.id = e.inscrit_par::integer
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 ${ecoleCond}
        GROUP BY u.nom
        HAVING COUNT(*) FILTER (WHERE e.date_inscription::date >= CURRENT_DATE - INTERVAL '29 days') > 0
        ORDER BY total_30j DESC
        LIMIT 10
      `, baseParams),
    ]);

    const activiteAgents = activiteAgentsResult.rows.map((r) => {
      const recent = parseInt(r.total_15j_recent, 10);
      const precedent = parseInt(r.total_15j_precedent, 10);
      let tendance = 'stable';
      if (precedent > 0) {
        const variation = (recent - precedent) / precedent;
        if (variation >= 0.15) tendance = 'hausse';
        else if (variation <= -0.15) tendance = 'baisse';
      } else if (recent > 0) {
        tendance = 'hausse';
      }
      return {
        agent: r.agent,
        total_30j: parseInt(r.total_30j, 10),
        moyenne_jour: Math.round((parseInt(r.total_30j, 10) / 30) * 10) / 10,
        tendance,
      };
    });

    const totalOrigine = origineResult.rows.reduce((sum, r) => sum + parseInt(r.total, 10), 0);
    const origineWeb = origineResult.rows.find((r) => r.source === 'web');
    const origineAgent = origineResult.rows.find((r) => r.source !== 'web');

    res.status(200).json({
      success: true,
      data: {
        totalInscrits: parseInt(totalInscrits.rows[0].total, 10),
        inscriptionsAujourdhui: parseInt(aujourdhui.rows[0].total, 10),
        inscriptionsHier: parseInt(hier.rows[0].total, 10),
        inscriptionsCetteSemaine: parseInt(cetteSemaine.rows[0].total, 10),
        inscriptionsSemaineDerniere: parseInt(semaineDerniere.rows[0].total, 10),
        origine: {
          web_pct: totalOrigine > 0 ? Math.round(((origineWeb ? parseInt(origineWeb.total, 10) : 0) / totalOrigine) * 100) : 0,
          agent_pct: totalOrigine > 0 ? Math.round(((origineAgent ? parseInt(origineAgent.total, 10) : 0) / totalOrigine) * 100) : 0,
        },
        evolutionQuotidienne: evolutionResult.rows.map((r) => ({ jour: r.jour, total: parseInt(r.total, 10) })),
        parEcole: parEcoleResult.rows.map((r) => ({ ecole: r.ecole, total: parseInt(r.total, 10) })),
        parNiveau: parNiveauResult.rows.map((r) => ({ niveau: r.niveau, total: parseInt(r.total, 10) })),
        parFiliere: parFiliereResult.rows.map((r) => ({ filiere: r.filiere, total: parseInt(r.total, 10) })),
        activiteAgents,
      },
    });
  } catch (error) {
    console.error('Erreur getDashboardScolarite:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

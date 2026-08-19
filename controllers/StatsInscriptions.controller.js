const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { getInscriptionsValideesPeriodes } = require('../services/statistiquesInscriptions.service');
const { getDossiersEnAttenteParOrigine } = require('../services/dossiersEnAttente.service');

exports.getStatsInscriptions = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const departementId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    const anneeAcademiqueId = req.query.anneeAcademiqueId || await getAnneeAcademiqueCourante(departementId);

    let dateCondition = '';
    let dateParams = [anneeAcademiqueId, departementId];

    if (startDate && endDate) {
      dateCondition = 'AND DATE(e.date_inscription) BETWEEN $3 AND $4';
      dateParams.push(startDate, endDate);
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site_id. L'index du
    // paramètre dépend de la présence ou non du filtre de dates ($3/$4 déjà pris si présent).
    const ecoleIdx = dateParams.length + 1;
    const ecoleCondAliasE = ecoleId !== null
      ? `AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $${ecoleIdx})`
      : '';
    const ecoleCondNoAlias = ecoleId !== null
      ? `AND id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $${ecoleIdx})`
      : '';
    if (ecoleId !== null) dateParams.push(ecoleId);

    // 1. Nombre total d'étudiants inscrits
    // ✅ vue_position_academique (pas `etudiant` directement, ici et dans les requêtes suivantes
    // qui comptent des étudiants "de l'année $1") : etudiant.annee_academique_id n'est qu'une
    // position COURANTE — un étudiant réinscrit vers l'année suivante ne doit pas disparaître
    // rétroactivement des statistiques de l'année où il a réellement été admis/positionné.
    const nbEtudiants = await db.query(`
      SELECT COUNT(*) AS total
      FROM vue_position_academique e
      WHERE e.annee_academique_id = $1
        AND e.site_id = $2
        AND e.standing = 'Inscrit'
        ${dateCondition}
        ${ecoleCondAliasE}
    `, dateParams);

    // 2. Inscriptions aujourd'hui + 4. Confirmés aujourd'hui
    // ✅ Chantier Statistiques (2026-08-18) : ancienne requête #2 ne filtrait sur AUCUN standing
    // (un dossier en attente de paiement créé aujourd'hui était compté comme "inscription
    // aujourd'hui"), et les deux utilisaient etudiant.date_inscription (date de création du
    // dossier) au lieu de la date réelle de finalisation caisse. Source unique désormais — voir
    // services/statistiquesInscriptions.service.js. Les deux valeurs coïncident maintenant par
    // construction (toutes deux = admissions+réinscriptions validées aujourd'hui).
    const periodesValidees = await getInscriptionsValideesPeriodes(db, { siteId: departementId, ecoleId, anneeAcademiqueId });
    const aujourdhui = { rows: [{ total: periodesValidees.aujourd_hui }] };
    const confirmesAujourdhui = { rows: [{ total: periodesValidees.aujourd_hui }] };

    // 3. Étudiants en attente
    // ✅ Chantier Statistiques (2026-08-18) : l'ancienne requête ne comptait que les admissions en
    // attente (etudiant.standing = 'en attente') — une réinscription en attente de paiement ne
    // touche jamais etudiant.annee_academique_id/standing avant son passage en caisse (voir
    // caisse.controller.js::validerPaiementReinscription), donc n'était JAMAIS comptée ici. Source
    // unique désormais — voir services/dossiersEnAttente.service.js.
    const dossiersEnAttenteStats = await getDossiersEnAttenteParOrigine(db, { siteId: departementId, ecoleId, anneeAcademiqueId });
    const enAttente = { rows: [{ total: dossiersEnAttenteStats.admissions.total + dossiersEnAttenteStats.reinscriptions.total }] };

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
      LEFT JOIN vue_position_academique e ON u.id = e.inscrit_par::integer
      WHERE e.annee_academique_id = $1
        AND e.site_id = $2
        ${startDate && endDate ? 'AND DATE(e.date_inscription) BETWEEN $3 AND $4' : ''}
        ${ecoleCondAliasE}
      GROUP BY u.id, u.nom, u.email
      ORDER BY total_inscrits DESC
    `, dateParams);

    // 6. Inscriptions journalières
    const inscriptionsJournalieres = await db.query(`
      SELECT
        DATE(date_inscription) AS date,
        COUNT(*) AS nombre_inscriptions,
        SUM(CASE WHEN standing = 'Inscrit' THEN 1 ELSE 0 END) AS confirmes
      FROM vue_position_academique
      WHERE annee_academique_id = $1
        AND site_id = $2
        ${startDate && endDate ? 'AND DATE(date_inscription) BETWEEN $3 AND $4' : ''}
        ${ecoleCondNoAlias}
      GROUP BY DATE(date_inscription)
      ORDER BY date DESC
    `, dateParams);

    // 7. Statistiques par statut
    const statsParStatut = await db.query(`
      SELECT
        statut_scolaire,
        COUNT(*) AS nombre
      FROM vue_position_academique
      WHERE annee_academique_id = $1
        AND site_id = $2
        ${startDate && endDate ? 'AND DATE(date_inscription) BETWEEN $3 AND $4' : ''}
        ${ecoleCondNoAlias}
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
        AND e.site_id = $2
        ${startDate && endDate ? 'AND DATE(p.date_paiement) BETWEEN $3 AND $4' : ''}
        ${ecoleCondAliasE}
      GROUP BY u.id, u.nom, u.email
      ORDER BY nombre_paiements DESC
    `, dateParams);

    // 9. NOUVEAU : Total des paiements (SIMPLIFIÉ)
    const totalPaiements = await db.query(`
      SELECT COUNT(p.id) AS nombre_total_paiements
      FROM paiement p
      JOIN etudiant e ON p.etudiant_id = e.id
      WHERE e.annee_academique_id = $1
        AND e.site_id = $2
        ${startDate && endDate ? 'AND DATE(p.date_paiement) BETWEEN $3 AND $4' : ''}
        ${ecoleCondAliasE}
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

// Fonction utilitaire pour obtenir l'année académique courante d'un site
async function getAnneeAcademiqueCourante(siteId) {
  try {
    const result = await db.query(`
      SELECT a.id FROM anneeacademique a
      JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
      WHERE s.site_id = $1 AND s.etat = 'en cour'
      LIMIT 1
    `, [siteId]);
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
    const ecoleId = getEcoleScopeFromUser(req);
    const anneeAcademiqueId = req.query.anneeAcademiqueId || await getAnneeAcademiqueCourante(departementId);

    const params = [anneeAcademiqueId, departementId];
    let dateCondition = '';

    if (startDate && endDate) {
      dateCondition = 'AND DATE(date_inscription) BETWEEN $3 AND $4';
      params.push(startDate, endDate);
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site_id.
    const ecoleCondNoAlias = ecoleId !== null
      ? `AND id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $${params.length + 1})`
      : '';
    if (ecoleId !== null) params.push(ecoleId);

    // ✅ Chantier Statistiques (2026-08-18) : total_attente et aujourdhui/hier sourcés désormais
    // sur la définition centralisée (services/statistiquesInscriptions.service.js) — l'ancien
    // "aujourdhui"/"hier" ne filtrait sur aucun standing et utilisait date_inscription (création
    // du dossier) au lieu de la date réelle de validation caisse.
    const [result, periodesValidees, dossiersEnAttenteStats] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE standing = 'Inscrit') AS total_inscrits,
          COUNT(*) FILTER (WHERE sexe = 'M') AS hommes,
          COUNT(*) FILTER (WHERE sexe = 'F') AS femmes
        FROM vue_position_academique
        WHERE annee_academique_id = $1
          AND site_id = $2
          ${dateCondition}
          ${ecoleCondNoAlias}
      `, params),
      getInscriptionsValideesPeriodes(db, { siteId: departementId, ecoleId, anneeAcademiqueId }),
      getDossiersEnAttenteParOrigine(db, { siteId: departementId, ecoleId, anneeAcademiqueId }),
    ]);

    res.json({
      total_inscrits: result.rows[0].total_inscrits,
      total_attente: dossiersEnAttenteStats.admissions.total + dossiersEnAttenteStats.reinscriptions.total,
      hommes: result.rows[0].hommes,
      femmes: result.rows[0].femmes,
      aujourdhui: periodesValidees.aujourd_hui,
      hier: periodesValidees.hier,
    });

  } catch (error) {
    console.error('Erreur stats détaillées:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
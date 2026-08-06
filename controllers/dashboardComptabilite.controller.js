// Dashboard Comptabilité (Chantier 2, 2026-08-02) — vue financière consolidée de tout le site
// (toutes caisses confondues), à la différence de caisse.controller.js::getDashboardStats qui
// reste scopé à l'activité personnelle d'un caissier. Conforme à la maquette validée le
// 2026-08-01. Cloisonnement par site (req.user.departement_id) et par école (Chantier 3,
// cumulatif via jointure etudiant→filiere→departement→ecole, paiement n'ayant pas ce lien direct).
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

exports.getDashboardComptabilite = async (req, res) => {
  try {
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (c.site_id), via
    // l'étudiant (paiement n'a pas de lien direct vers filiere/departement/ecole).
    const ecoleCond = ecoleId !== null
      ? 'AND p.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3))'
      : '';
    const baseParams = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];

    const [
      recettesJour,
      recettesHier,
      recettesSemaine,
      recettesSemaineDerniere,
      recettesMois,
      recettesAnnee,
      evolutionResult,
      methodeResult,
      parCaisseResult,
      enAttenteResult,
    ] = await Promise.all([
      db.query(`
        SELECT COALESCE(SUM(p.montant), 0) AS total FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2 AND p.date_paiement = CURRENT_DATE ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COALESCE(SUM(p.montant), 0) AS total FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2 AND p.date_paiement = CURRENT_DATE - INTERVAL '1 day' ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COALESCE(SUM(p.montant), 0) AS total FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2
          AND p.date_paiement >= date_trunc('week', CURRENT_DATE) ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COALESCE(SUM(p.montant), 0) AS total FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2
          AND p.date_paiement >= date_trunc('week', CURRENT_DATE) - INTERVAL '7 days'
          AND p.date_paiement < date_trunc('week', CURRENT_DATE) ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COALESCE(SUM(p.montant), 0) AS total FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2
          AND p.date_paiement >= date_trunc('month', CURRENT_DATE) ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT COALESCE(SUM(p.montant), 0) AS total FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2 ${ecoleCond}
      `, baseParams),

      db.query(`
        SELECT p.date_paiement AS jour, COALESCE(SUM(p.montant), 0) AS total
        FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2
          AND p.date_paiement BETWEEN CURRENT_DATE - INTERVAL '13 days' AND CURRENT_DATE ${ecoleCond}
        GROUP BY p.date_paiement ORDER BY jour
      `, baseParams),

      // Regroupement insensible à la casse ("especes" / "Espèces" coexistent en base) — constat
      // de qualité de donnée signalé au compte rendu, non corrigé ici (hors périmètre).
      db.query(`
        SELECT INITCAP(p.methode) AS methode, COALESCE(SUM(p.montant), 0) AS total
        FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2
          AND p.date_paiement >= date_trunc('month', CURRENT_DATE) ${ecoleCond}
        GROUP BY INITCAP(p.methode) ORDER BY total DESC
      `, baseParams),

      db.query(`
        SELECT c.libelle AS caisse,
          COALESCE(SUM(p.montant) FILTER (WHERE p.date_paiement = CURRENT_DATE), 0) AS aujourd_hui,
          COALESCE(SUM(p.montant) FILTER (WHERE p.date_paiement >= date_trunc('month', CURRENT_DATE)), 0) AS ce_mois
        FROM caisse c
        LEFT JOIN paiement p ON p.caisse_id = c.id AND p.annee_academique_id = $1 ${ecoleCond}
        WHERE c.site_id = $2
        GROUP BY c.libelle ORDER BY c.libelle
      `, baseParams),

      // Paiements en attente — même requête que caisse.controller.js::getDashboardStats, mais
      // pour tout le site (jamais scopée à un caissier, cette notion n'existe pas ici).
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM etudiant e WHERE e.standing = 'en attente' AND e.site_id = $1
            ${ecoleId !== null ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $2)' : ''}
          ) AS admissions_en_attente,
          (SELECT COUNT(*) FROM reinscription r JOIN etudiant e2 ON e2.id = r.etudiant_id
            WHERE r.statut = 'en_attente_paiement' AND e2.site_id = $1
            ${ecoleId !== null ? 'AND e2.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $2)' : ''}
          ) AS reinscriptions_en_attente
      `, ecoleId !== null ? [siteId, ecoleId] : [siteId]),
    ]);

    res.status(200).json({
      success: true,
      data: {
        recettesJour: parseFloat(recettesJour.rows[0].total),
        recettesHier: parseFloat(recettesHier.rows[0].total),
        recettesSemaine: parseFloat(recettesSemaine.rows[0].total),
        recettesSemaineDerniere: parseFloat(recettesSemaineDerniere.rows[0].total),
        recettesMois: parseFloat(recettesMois.rows[0].total),
        recettesAnnee: parseFloat(recettesAnnee.rows[0].total),
        evolutionEncaissements: evolutionResult.rows.map((r) => ({ jour: r.jour, total: parseFloat(r.total) })),
        repartitionMethode: methodeResult.rows.map((r) => ({ methode: r.methode, total: parseFloat(r.total) })),
        parCaisse: parCaisseResult.rows.map((r) => ({
          caisse: r.caisse,
          aujourd_hui: parseFloat(r.aujourd_hui),
          ce_mois: parseFloat(r.ce_mois),
        })),
        enAttente: {
          admissions: parseInt(enAttenteResult.rows[0].admissions_en_attente, 10),
          reinscriptions: parseInt(enAttenteResult.rows[0].reinscriptions_en_attente, 10),
        },
      },
    });
  } catch (error) {
    console.error('Erreur getDashboardComptabilite:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

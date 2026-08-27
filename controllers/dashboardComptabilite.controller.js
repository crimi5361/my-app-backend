// Dashboard Comptabilité (Chantier 2, 2026-08-02) — vue financière consolidée de tout le site
// (toutes caisses confondues), à la différence de caisse.controller.js::getDashboardStats qui
// reste scopé à l'activité personnelle d'un caissier. Conforme à la maquette validée le
// 2026-08-01. Cloisonnement par site (req.user.departement_id) et par école (Chantier 3,
// cumulatif via jointure etudiant→filiere→departement→ecole, paiement n'ayant pas ce lien direct).
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { getStatistiquesKit } = require('../services/kitStatistiques.service');
// ✅ Chantier Dashboards financiers par type (2026-08-27) : "Étudiants inscrits" — même source
// UNIQUE que le Dashboard Fondateur (services/statistiquesInscriptions.service.js), aucune
// deuxième logique de comptage. Vérifié avant modification : getTotalInscrits est déjà réutilisée
// telle quelle par dashboardAdministrateur.controller.js et dashboardFondateur.controller.js ;
// getEvolutionRecettesQuotidienne n'est PAS utilisée ici (le Dashboard Comptabilité a sa propre
// fenêtre "14 derniers jours", volontairement différente de celle du Fondateur — non touchée).
const { getTotalInscrits } = require('../services/statistiquesInscriptions.service');

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

    // ✅ Variante utilisée sur vue_position_academique/etudiant (alias e = étudiant directement,
    // pas paiement) — même condition, même forme que dashboardFondateur.controller.js
    // (ecoleCondEtudiant), reprise à l'identique pour le bloc finance ci-dessous.
    const ecoleCondEtudiant = ecoleId !== null
      ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3)'
      : '';

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
      financeResult,
      pecResult,
      statistiquesKit,
      totalInscrits,
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

      // ✅ Chantier Dashboards financiers par type (2026-08-27) : ventilation par `type_frais`
      // ajoutée dans LA MÊME requête (GROUP BY supplémentaire), pour que le total par jour reste
      // mathématiquement la somme des types — même convention COALESCE que caisse.controller.js
      // (buildRapportSession/getSupervisionCaisse), période 14 jours INCHANGÉE.
      db.query(`
        SELECT p.date_paiement AS jour,
               COALESCE(NULLIF(p.type_frais, ''), 'scolarite') AS type_frais,
               COALESCE(SUM(p.montant), 0) AS total
        FROM paiement p JOIN caisse c ON c.id = p.caisse_id
        WHERE p.annee_academique_id = $1 AND c.site_id = $2
          AND p.date_paiement BETWEEN CURRENT_DATE - INTERVAL '13 days' AND CURRENT_DATE ${ecoleCond}
        GROUP BY p.date_paiement, COALESCE(NULLIF(p.type_frais, ''), 'scolarite')
        ORDER BY jour
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

      // ✅ Scolarité totale / versé / restant — mêmes indicateurs, même requête que
      // dashboardFondateur.controller.js (vue_position_academique : montants toujours corrects
      // par branche, y compris pour un étudiant réinscrit depuis une année déjà clôturée).
      // Réutilisé à l'identique, pas réinventé (règle explicite du chantier).
      db.query(`
        SELECT
          COALESCE(SUM(e.montant_scolarite), 0) AS total_scolarite,
          COALESCE(SUM(e.scolarite_verse), 0) AS total_verse,
          COALESCE(SUM(e.scolarite_restante), 0) AS total_restant
        FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCondEtudiant}
      `, baseParams),

      // ✅ Prises en charge validées — même requête que dashboardFondateur.controller.js.
      db.query(`
        SELECT COALESCE(SUM(p.montant_reduction), 0) AS total, COUNT(*) AS nombre
        FROM prise_en_charge p JOIN etudiant e ON e.id = p.etudiant_id
        WHERE p.statut = 'valide' AND p.annee_academique_id = $1 AND e.site_id = $2 ${ecoleCondEtudiant}
      `, baseParams),

      // Chantier Kit étudiant — Phase statistiques (2026-08-21) : voir services/kitStatistiques.service.js.
      getStatistiquesKit(db, { siteId, anneeAcademiqueId, ecoleId }),

      // ✅ Chantier Dashboards financiers par type (2026-08-27) — même source unique que le
      // Dashboard Fondateur, voir commentaire d'import ci-dessus.
      getTotalInscrits(db, { siteId, ecoleId, anneeAcademiqueId }),
    ]);

    // ✅ Pivot {jour, type_frais, total} → [{jour, total, parType}] — même transformation que
    // services/statistiquesInscriptions.service.js::getEvolutionRecettesQuotidienne, reprise ici
    // (pas extraite en commun) car cette requête a sa propre fenêtre "14 derniers jours",
    // volontairement distincte de celle du Fondateur (depuis le 1er jour de l'année académique).
    const evolutionParJour = new Map();
    for (const row of evolutionResult.rows) {
      const jour = row.jour instanceof Date ? row.jour.toISOString().slice(0, 10) : String(row.jour);
      if (!evolutionParJour.has(jour)) evolutionParJour.set(jour, { jour, total: 0, parType: {} });
      const entry = evolutionParJour.get(jour);
      const montant = parseFloat(row.total);
      entry.total += montant;
      entry.parType[row.type_frais] = montant;
    }
    const evolutionEncaissements = Array.from(evolutionParJour.values()).sort((a, b) => a.jour.localeCompare(b.jour));

    res.status(200).json({
      success: true,
      data: {
        recettesJour: parseFloat(recettesJour.rows[0].total),
        recettesHier: parseFloat(recettesHier.rows[0].total),
        recettesSemaine: parseFloat(recettesSemaine.rows[0].total),
        recettesSemaineDerniere: parseFloat(recettesSemaineDerniere.rows[0].total),
        recettesMois: parseFloat(recettesMois.rows[0].total),
        recettesAnnee: parseFloat(recettesAnnee.rows[0].total),
        evolutionEncaissements,
        repartitionMethode: methodeResult.rows.map((r) => ({ methode: r.methode, total: parseFloat(r.total) })),
        // ✅ Chantier Dashboards financiers par type (2026-08-27) — même source unique que le
        // Dashboard Fondateur (services/statistiquesInscriptions.service.js::getTotalInscrits).
        totalInscrits,
        parCaisse: parCaisseResult.rows.map((r) => ({
          caisse: r.caisse,
          aujourd_hui: parseFloat(r.aujourd_hui),
          ce_mois: parseFloat(r.ce_mois),
        })),
        enAttente: {
          admissions: parseInt(enAttenteResult.rows[0].admissions_en_attente, 10),
          reinscriptions: parseInt(enAttenteResult.rows[0].reinscriptions_en_attente, 10),
        },
        finance: {
          total_scolarite: parseFloat(financeResult.rows[0].total_scolarite),
          total_verse: parseFloat(financeResult.rows[0].total_verse),
          total_restant: parseFloat(financeResult.rows[0].total_restant),
          total_pec: parseFloat(pecResult.rows[0].total),
          nombre_pec: parseInt(pecResult.rows[0].nombre, 10),
        },
        // Chantier Kit étudiant — Phase statistiques (2026-08-21).
        kit: statistiquesKit,
      },
    });
  } catch (error) {
    console.error('Erreur getDashboardComptabilite:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

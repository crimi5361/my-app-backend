// Dashboard Administrateur (Chantier 2, 2026-08-02, enrichi le 2026-08-02) — pilotage de
// l'administration de la plateforme : santé système, statistiques principales, utilisateurs,
// écoles, années académiques, journaux récents, alertes techniques, paramétrage, situation
// financière globale (4 postes uniquement, aucun détail caisse/méthode — ça reste le rôle du
// Dashboard Comptabilité) et statistiques étudiants (valeurs absolues, aucun pourcentage).
//
// Site-scopé comme tout le reste de l'application (aucun bypass "vue tous sites" pour admin).
// Cloisonnement par école (Chantier 3) appliqué uniquement aux nouveaux blocs étudiants/finance
// (données étudiants), jamais aux blocs utilisateurs/rôles/config (gestion des agents eux-mêmes,
// hors périmètre du cloisonnement école — même principe déjà validé pour Dashboard Caisse).
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { getDossiersEnAttenteParOrigine } = require('../services/dossiersEnAttente.service');
const { getTotalInscrits, getInscriptionsValidees } = require('../services/statistiquesInscriptions.service');
const { getStatistiquesKit } = require('../services/kitStatistiques.service');

exports.getDashboardAdministrateur = async (req, res) => {
  const debutRequete = Date.now();
  try {
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }

    const ecoleCond = ecoleId !== null
      ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3)'
      : '';
    const etudiantParams = ecoleId !== null ? [anneeAcademiqueId, siteId, ecoleId] : [anneeAcademiqueId, siteId];

    const [
      agentsParRole,
      agentsParEcoleScope,
      ecolesResult,
      departementsResult,
      filieresResult,
      niveauxResult,
      classesResult,
      sitesResult,
      anneesResult,
      etudiantsResult,
      etudiantsStatsResult,
      financeResult,
      pecResult,
      journalEcolesResult,
      journalDepartementsResult,
      dossiersEnAttente,
      inscriptionsValidees,
      statistiquesKit,
    ] = await Promise.all([
      db.query(`
        SELECT r.nom AS role, u.statut, COUNT(*) AS total
        FROM utilisateur u JOIN role r ON r.id = u.role_id
        WHERE u.site_id = $1
        GROUP BY r.nom, u.statut ORDER BY r.nom
      `, [siteId]),

      // Chantier 3 — combien d'agents de ce site sont déjà affectés à une école (périmètre
      // restreint) contre combien restent en vue globale (ecole_id NULL).
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE ecole_id IS NOT NULL) AS avec_ecole,
          COUNT(*) FILTER (WHERE ecole_id IS NULL) AS vue_globale
        FROM utilisateur WHERE site_id = $1 AND statut = 'active'
      `, [siteId]),

      db.query(`SELECT id, nom, statut FROM ecole ORDER BY nom`),
      db.query(`SELECT id, nom, ecole_id FROM departement ORDER BY nom`),

      // Filières/niveaux/classes recalculés pour l'année académique sélectionnée (demande
      // explicite : "toutes les statistiques affichées se recalculent selon l'année").
      db.query(`
        SELECT COUNT(DISTINCT f.id) AS total FROM filiere f
        JOIN niveau n ON n.filiere_id = f.id WHERE n.site_id = $1 AND n.anneeacademique_id = $2
      `, [siteId, anneeAcademiqueId]),
      db.query(`SELECT COUNT(*) AS total FROM niveau WHERE site_id = $1 AND anneeacademique_id = $2`, [siteId, anneeAcademiqueId]),
      db.query(`
        SELECT COUNT(DISTINCT c.id) AS total FROM classe c
        WHERE c.annee_academique_id = $1
          AND EXISTS (SELECT 1 FROM niveau n WHERE n.id = c.niveau_id AND n.site_id = $2)
      `, [anneeAcademiqueId, siteId]),
      db.query(`SELECT id, nom FROM site ORDER BY nom`),

      // Années académiques : configuration globale + état spécifique à ce site (liste complète,
      // indépendante de l'année sélectionnée — sert justement à la choisir).
      db.query(`
        SELECT a.id, a.annee, s.etat
        FROM anneeacademique a
        LEFT JOIN anneeacademique_site s ON s.anneeacademique_id = a.id AND s.site_id = $1
        ORDER BY a.annee DESC
      `, [siteId]),

      // ✅ Chantier Statistiques (2026-08-18) : source unique — voir
      // services/statistiquesInscriptions.service.js. Remplace un COUNT(*) local qui, à la
      // différence de `etudiantsStatsResult` juste en dessous, n'appliquait PAS le cloisonnement
      // école (ecoleCond) — un agent restreint à une école voyait ce total sur tout le site.
      getTotalInscrits(db, { siteId, ecoleId, anneeAcademiqueId }),

      // Statistiques étudiants demandées explicitement (valeurs absolues, aucun pourcentage).
      db.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE e.sexe = 'Masculin') AS hommes,
          COUNT(*) FILTER (WHERE e.sexe = 'Féminin') AS femmes,
          COUNT(*) FILTER (WHERE e.source_inscription = 'web') AS inscriptions_web,
          COUNT(*) FILTER (WHERE e.source_inscription = 'agent') AS inscriptions_agent
        FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCond}
      `, etudiantParams),

      // Situation financière globale — 4 postes uniquement, aucun détail caisse/méthode (reste
      // le rôle du Dashboard Comptabilité).
      // ✅ vue_position_academique (voir StatDashboard/Fondateur pour la justification complète).
      db.query(`
        SELECT
          COALESCE(SUM(e.montant_scolarite), 0) AS total_scolarite,
          COALESCE(SUM(e.scolarite_verse), 0) AS total_verse,
          COALESCE(SUM(e.scolarite_restante), 0) AS total_restant
        FROM vue_position_academique e
        WHERE e.annee_academique_id = $1 AND e.site_id = $2 AND e.standing = 'Inscrit' ${ecoleCond}
      `, etudiantParams),

      // ✅ Filtre sur p.annee_academique_id (capturé à la création de la PEC).
      db.query(`
        SELECT COALESCE(SUM(p.montant_reduction), 0) AS total
        FROM prise_en_charge p JOIN etudiant e ON e.id = p.etudiant_id
        WHERE p.statut = 'valide' AND p.annee_academique_id = $1 AND e.site_id = $2 ${ecoleCond}
      `, etudiantParams),

      // Journaux récents — uniquement les tables ayant réellement un horodatage de
      // création/modification (filiere/niveau/classe/site/utilisateur n'en ont aucun,
      // vérifié par introspection le 2026-08-02 : impossible de les journaliser honnêtement).
      db.query(`
        SELECT 'ecole' AS type, nom, created_at AS date, 'création' AS action FROM ecole
        UNION ALL
        SELECT 'ecole' AS type, nom, updated_at AS date, 'modification' AS action FROM ecole WHERE updated_at IS DISTINCT FROM created_at
        ORDER BY date DESC LIMIT 10
      `),
      db.query(`
        SELECT 'departement' AS type, nom, created_at AS date, 'création' AS action FROM departement
        ORDER BY date DESC LIMIT 10
      `),

      // Visibilité des dossiers en attente (admissions + réinscriptions), même définition/périmètre
      // que le dashboard Caisse — voir services/dossiersEnAttente.service.js.
      getDossiersEnAttenteParOrigine(db, { siteId, ecoleId, anneeAcademiqueId }),

      getInscriptionsValidees(db, { siteId, ecoleId, anneeAcademiqueId }),

      // Chantier Kit étudiant — Phase statistiques (2026-08-21) : voir services/kitStatistiques.service.js.
      getStatistiquesKit(db, { siteId, anneeAcademiqueId, ecoleId }),
    ]);

    const parRoleRaw = agentsParRole.rows;
    const rolesResult = await db.query(`SELECT nom FROM role ORDER BY nom`);
    const parRole = rolesResult.rows.map((r) => {
      const actifs = parRoleRaw.find((x) => x.role === r.nom && x.statut === 'active');
      const desactives = parRoleRaw.find((x) => x.role === r.nom && x.statut !== 'active');
      return {
        role: r.nom,
        actifs: actifs ? parseInt(actifs.total, 10) : 0,
        desactives: desactives ? parseInt(desactives.total, 10) : 0,
      };
    });
    const totalActifs = parRole.reduce((sum, r) => sum + r.actifs, 0);
    const totalDesactives = parRole.reduce((sum, r) => sum + r.desactives, 0);
    const rolesSansCompteActif = parRole.filter((r) => r.actifs === 0).map((r) => r.role);

    const ecolesInactives = ecolesResult.rows.filter((e) => e.statut !== 'actif').map((e) => e.nom);
    const anneeEnCoursPourCeSite = anneesResult.rows.find((a) => a.etat === 'en cour');

    // Journal consolidé (écoles + départements), fusionné et retrié — seules sources disponibles
    // avec un horodatage réel (cf. commentaire ci-dessus).
    const journal = [...journalEcolesResult.rows, ...journalDepartementsResult.rows]
      .filter((j) => j.date)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10)
      .map((j) => ({ type: j.type, nom: j.nom, action: j.action, date: j.date }));

    const alertes = [];
    if (rolesSansCompteActif.length > 0) {
      alertes.push({ niveau: 'warning', message: `Rôle(s) sans compte actif : ${rolesSansCompteActif.join(', ')}` });
    }
    if (ecolesInactives.length > 0) {
      alertes.push({ niveau: 'critical', message: `École(s) inactive(s) : ${ecolesInactives.join(', ')}` });
    }
    if (!anneeEnCoursPourCeSite) {
      alertes.push({ niveau: 'critical', message: "Aucune année académique « en cours » n'est configurée pour votre site." });
    }

    res.status(200).json({
      success: true,
      data: {
        sante: {
          base_de_donnees: 'ok',
          uptime_secondes: Math.round(process.uptime()),
          environnement: process.env.NODE_ENV === 'production' ? 'production' : 'local',
          temps_reponse_ms: Date.now() - debutRequete,
        },
        statistiques: {
          totalEtudiants: etudiantsResult,
          totalAgentsActifs: totalActifs,
          totalAgentsDesactives: totalDesactives,
          nb_classes: parseInt(classesResult.rows[0].total, 10),
        },
        etudiants: {
          total: parseInt(etudiantsStatsResult.rows[0].total, 10),
          hommes: parseInt(etudiantsStatsResult.rows[0].hommes, 10),
          femmes: parseInt(etudiantsStatsResult.rows[0].femmes, 10),
          inscriptions_web: parseInt(etudiantsStatsResult.rows[0].inscriptions_web, 10),
          inscriptions_agent: parseInt(etudiantsStatsResult.rows[0].inscriptions_agent, 10),
          admissions_validees: inscriptionsValidees.admissions,
          reinscriptions_validees: inscriptionsValidees.reinscriptions,
        },
        finance: {
          total_scolarite: parseFloat(financeResult.rows[0].total_scolarite),
          total_verse: parseFloat(financeResult.rows[0].total_verse),
          total_restant: parseFloat(financeResult.rows[0].total_restant),
          total_pec: parseFloat(pecResult.rows[0].total),
        },
        utilisateurs: {
          parRole,
          rolesSansCompteActif,
          cloisonnementEcole: {
            avec_ecole: parseInt(agentsParEcoleScope.rows[0].avec_ecole, 10),
            vue_globale: parseInt(agentsParEcoleScope.rows[0].vue_globale, 10),
          },
        },
        ecoles: ecolesResult.rows.map((e) => ({ id: e.id, nom: e.nom, statut: e.statut })),
        anneesAcademiques: anneesResult.rows.map((a) => ({ id: a.id, annee: a.annee, etat: a.etat || 'non configurée pour ce site' })),
        journal,
        alertes,
        parametrage: {
          nb_sites: sitesResult.rows.length,
          nb_ecoles: ecolesResult.rows.length,
          nb_departements: departementsResult.rows.length,
          nb_filieres: parseInt(filieresResult.rows[0].total, 10),
          nb_niveaux: parseInt(niveauxResult.rows[0].total, 10),
          nb_classes: parseInt(classesResult.rows[0].total, 10),
          nb_annees_academiques: anneesResult.rows.length,
        },
        // Ajout — visibilité des dossiers en attente de paiement (admissions + réinscriptions),
        // même définition que le dashboard Caisse, avec répartition par origine (source_inscription).
        dossiersEnAttente,
        // Chantier Kit étudiant — Phase statistiques (2026-08-21).
        kit: statistiquesKit,
      },
    });
  } catch (error) {
    console.error('Erreur getDashboardAdministrateur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

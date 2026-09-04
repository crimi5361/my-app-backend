const db = require('../config/db.config');

exports.getAllCertificatFrequentation = async (req, res) => {
  try {
    const { id } = req.params;
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user?.departement_id;

    if (!id || isNaN(id)) {
      return res.status(400).json({
        success: false,
        message: "ID étudiant invalide",
        code: "INVALID_STUDENT_ID"
      });
    }
    if (!siteId) {
      return res.status(400).json({
        success: false,
        message: "Site de l'agent introuvable",
        code: "DEPARTMENT_ID_REQUIRED"
      });
    }

    // ✅ Cloisonnement par site (Chantier "Fiche étudiant + Historique PEC + Certificats par
    // année", 2026-09-04) — cette requête n'était filtrée que sur l'id, permettant à un agent
    // admin/scolarite d'imprimer le certificat d'un étudiant d'un autre site en connaissant son
    // id. Décision explicite du demandeur : corrigé ici (contrairement à getEtudiantById /
    // updateInformationsPersonnelles, où la même faille préexiste mais reste hors périmètre —
    // voir rapport final).
    const params = [id, siteId];
    // ✅ Source vue_position_academique (au lieu de etudiant directement) — même correction que
    // CertificatScolarite.controller.js. Sans anneeAcademiqueId : position COURANTE
    // (e.position_historique = false). Avec anneeAcademiqueId : position FIGÉE de cette année
    // précise (voir audit validé).
    let anneeCondition = 'e.position_historique = false';
    if (anneeAcademiqueId) {
      params.push(anneeAcademiqueId);
      anneeCondition = `e.annee_academique_id = $${params.length}`;
    }

    // Requête pour récupérer les données de base de l'étudiant — position de l'année demandée
    // (ou courante par défaut), jamais uniquement sa position actuelle.
    const queryBase = `
      SELECT
        e.id,
        e.matricule,
        e.nom,
        e.prenoms,
        e.date_naissance,
        e.lieu_naissance,
        e.telephone,
        e.email,
        e.lieu_residence,
        e.contact_parent,
        e.code_unique,
        e.annee_bac,
        e.serie_bac,
        e.etablissement_origine,
        e.photo_url,
        -- ✅ date_inscription_annee (résolue par la vue pour CETTE année précise), jamais
        -- e.date_inscription seule (figée à la toute première admission) — même convention que
        -- CertificatScolarite.controller.js et controllers/etudiant.controller.js.
        e.date_inscription_annee,
        e.statut_scolaire,
        -- Correctif (2026-08-14) : même résolution que CertificatScolarite.controller.js —
        -- etudiant.nationalite stocke un code ISO (parfois un nom de pays hérité), jamais
        -- l'adjectif attendu sur le certificat. Repli sur la valeur brute si non résolue.
        COALESCE(p_nat.nationalite, e.nationalite) AS nationalite,
        e.sexe,
        e.contact_etudiant,
        e.contact_parent_2,
        e.matricule_iipea,
        e.pays_naissance,
        e.nom_parent_1,
        e.nom_parent_2,

        f.id as filiere_id,
        f.nom as filiere_nom,
        f.sigle as filiere_sigle,

        n.id as niveau_id,
        n.libelle as niveau_libelle,
        n.prix_formation as niveau_prix,

        a.id as annee_academique_id,
        a.annee as annee_academique,
        aas.etat as annee_etat,

        g.id as groupe_id,
        g.nom as groupe_nom,
        g.capacite_max as groupe_capacite,

        c.id as classe_id,
        c.nom as classe_nom,

        d.extrait_naissance,
        d.justificatif_identite,
        d.dernier_diplome,
        d.fiche_orientation,

        -- Informations de la scolarité — déjà résolues par vue_position_academique selon la
        -- branche (courante ou figée), jamais via etudiant.scolarite_id directement.
        e.montant_scolarite,
        e.scolarite_verse,
        e.scolarite_restante

      FROM vue_position_academique e
      LEFT JOIN pays p_nat ON p_nat.code_iso = e.nationalite OR p_nat.nom = e.nationalite
      LEFT JOIN filiere f ON e.id_filiere = f.id
      LEFT JOIN niveau n ON e.niveau_id = n.id
      LEFT JOIN anneeacademique a ON e.annee_academique_id = a.id
      LEFT JOIN anneeacademique_site aas ON aas.anneeacademique_id = a.id AND aas.site_id = e.site_id
      LEFT JOIN groupe g ON e.groupe_id = g.id
      LEFT JOIN classe c ON g.classe_id = c.id
      LEFT JOIN document d ON e.document_id = d.id
      WHERE e.id = $1 AND e.site_id = $2 AND ${anneeCondition}
    `;

    // ✅ Correctif (2026-09-04) — Point critique de l'audit : cette requête était documentée
    // "historique" mais ne lisait que `etudiant` (WHERE e.id = $1), donc renvoyait TOUJOURS une
    // seule ligne, la position COURANTE, jamais un véritable historique. Corrigé en reproduisant
    // le même patron déjà utilisé et vérifié dans
    // controllers/caisse.controller.js::getHistoriqueAnneesEtudiant : position courante (depuis
    // `etudiant`) + positions déjà quittées (depuis `historique_inscription`, événement
    // 'cloture'), combinées en JS. Indépendant de l'année sélectionnée pour l'en-tête du
    // certificat ci-dessus — ce tableau montre TOUJOURS le parcours complet de l'étudiant.
    const queryAnneeCourante = `
      SELECT e.annee_academique_id AS annee_id, aa.annee AS annee_academique,
             n.libelle AS niveau_libelle, f.nom AS filiere_nom,
             g.nom AS groupe_nom, g.est_primaire AS groupe_est_primaire, c.nom AS classe_nom,
             e.date_inscription
      FROM etudiant e
      LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
      LEFT JOIN niveau n ON n.id = e.niveau_id
      LEFT JOIN filiere f ON f.id = e.id_filiere
      LEFT JOIN groupe g ON g.id = e.groupe_id
      LEFT JOIN classe c ON c.id = g.classe_id
      WHERE e.id = $1 AND e.site_id = $2
    `;
    const queryAnneesPassees = `
      SELECT DISTINCT ON (hi.annee_academique_id)
             hi.annee_academique_id AS annee_id, aa.annee AS annee_academique,
             n.libelle AS niveau_libelle, f.nom AS filiere_nom,
             g.nom AS groupe_nom, g.est_primaire AS groupe_est_primaire, c.nom AS classe_nom,
             e.date_inscription
      FROM historique_inscription hi
      JOIN etudiant e ON e.id = hi.etudiant_id
      LEFT JOIN anneeacademique aa ON aa.id = hi.annee_academique_id
      LEFT JOIN niveau n ON n.id = hi.niveau_id
      LEFT JOIN filiere f ON f.id = hi.id_filiere
      LEFT JOIN groupe g ON g.id = hi.groupe_id
      LEFT JOIN classe c ON c.id = g.classe_id
      WHERE hi.etudiant_id = $1 AND e.site_id = $2
        AND hi.annee_academique_id IS DISTINCT FROM e.annee_academique_id
      ORDER BY hi.annee_academique_id, hi.created_at DESC
    `;

    const [resultBase, resultAnneeCourante, resultAnneesPassees] = await Promise.all([
      db.query(queryBase, params),
      db.query(queryAnneeCourante, [id, siteId]),
      db.query(queryAnneesPassees, [id, siteId])
    ]);

    if (resultBase.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Étudiant non trouvé pour cette année académique",
        code: "STUDENT_NOT_FOUND"
      });
    }

    const etudiantData = resultBase.rows[0];

    // ✅ Correctif (2026-09-04) — précision explicite du demandeur : le certificat d'une année
    // sélectionnée ne doit JAMAIS laisser fuiter une donnée d'une année ULTÉRIEURE. Le tableau
    // "historique" doit se comporter comme s'il avait été produit à l'époque de l'année
    // sélectionnée : uniquement les années <= celle demandée (ou courante par défaut, résolue
    // ci-dessus dans queryBase — etudiantData.annee_academique). Comparaison lexicographique sur
    // le libellé "AAAA-AAAA" : valide car format constant, jamais l'id (non chronologique — voir
    // vue_position_academique, où 2025-2026 = id 1 et 2026-2027 = id 3).
    const anneeLimite = etudiantData.annee_academique;

    // Structurer l'historique — position courante + positions passées, jamais au-delà de
    // anneeLimite, triées année décroissante.
    const historiqueAnnees = [...resultAnneeCourante.rows, ...resultAnneesPassees.rows]
      .filter(row => row.annee_academique && row.annee_academique <= anneeLimite)
      .sort((a, b) => (b.annee_academique || '').localeCompare(a.annee_academique || ''))
      .map(row => ({
        annee: row.annee_academique,
        annee_id: row.annee_id,
        niveau: row.niveau_libelle,
        filiere: row.filiere_nom,
        // Chantier 11 (2026-08-04) — sous-phase 2 : Groupe primaire jamais affiché, classe toujours disponible.
        groupe: row.groupe_est_primaire ? null : row.groupe_nom,
        classe: row.classe_nom,
        date_inscription: row.date_inscription
      }));

    // Structurer les données pour le frontend
    const certificatData = {
      informations_personnelles: {
        id: etudiantData.id,
        matricule: etudiantData.matricule,
        code_unique: etudiantData.code_unique,
        nom: etudiantData.nom,
        prenoms: etudiantData.prenoms,
        date_naissance: etudiantData.date_naissance,
        lieu_naissance: etudiantData.lieu_naissance,
        sexe: etudiantData.sexe,
        nationalite: etudiantData.nationalite,
        telephone: etudiantData.telephone,
        email: etudiantData.email,
        contact_etudiant: etudiantData.contact_etudiant,
        contact_parent: etudiantData.contact_parent,
        contact_parent_2: etudiantData.contact_parent_2,
        lieu_residence: etudiantData.lieu_residence,
        photo_url: etudiantData.photo_url,
        matricule_iipea: etudiantData.matricule_iipea,
        pays_naissance: etudiantData.pays_naissance,
        nom_parent_1: etudiantData.nom_parent_1,
        nom_parent_2: etudiantData.nom_parent_2
      },

      informations_academiques: {
        filiere: {
          id: etudiantData.filiere_id,
          nom: etudiantData.filiere_nom,
          sigle: etudiantData.filiere_sigle
        },
        niveau: {
          id: etudiantData.niveau_id,
          libelle: etudiantData.niveau_libelle
        },
        annee_academique: {
          id: etudiantData.annee_academique_id,
          annee: etudiantData.annee_academique
        }
      },

      historique_annees: historiqueAnnees,

      historique: {
        annee_bac: etudiantData.annee_bac,
        serie_bac: etudiantData.serie_bac,
        etablissement_origine: etudiantData.etablissement_origine,
        date_inscription: etudiantData.date_inscription_annee,
        statut_scolaire: etudiantData.statut_scolaire
      }
    };

    return res.status(200).json({
      success: true,
      data: certificatData,
      message: "Données du certificat de fréquentation récupérées avec succès"
    });

  } catch (err) {
    console.error("Erreur récupération données certificat de fréquentation:", err);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur lors de la récupération des données du certificat",
      code: "CERTIFICAT_FREQUENTATION_SERVER_ERROR",
      details: err.message
    });
  }
};

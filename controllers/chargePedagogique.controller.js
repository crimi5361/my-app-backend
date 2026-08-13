// Module Gestion des Enseignants (2026-08-11) — Espace Chargé Pédagogique (§3.1).
//
// Tout ce qui est exposé ici est borné par le périmètre du CP connecté (filières/niveaux
// rattachés). La restriction n'est jamais réécrite à la main : elle passe par
// services/perimetreCP.service.js, seule source de vérité.
const db = require('../config/db.config');
const {
  clausePerimetre,
  getPerimetre,
  verifierFiliereDansPerimetre,
} = require('../services/perimetreCP.service');

// ---------------------------------------------------------------------------
//  Périmètre & référentiels
// ---------------------------------------------------------------------------

exports.getMonPerimetre = async (req, res) => {
  try {
    const perimetre = await getPerimetre(req);
    res.status(200).json({ success: true, data: perimetre });
  } catch (error) {
    console.error('Erreur getMonPerimetre:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/** Classes du périmètre — alimente les sélecteurs de l'emploi du temps. */
exports.getMesClasses = async (req, res) => {
  try {
    const { annee_id } = req.query;
    const perim = clausePerimetre(req, 'c.filiere_id', 'c.niveau_id', 2);

    const result = await db.query(
      `SELECT c.id, c.nom, c.filiere_id, c.niveau_id, c.annee_academique_id,
              f.nom AS filiere, f.sigle, n.libelle AS niveau, aa.annee AS annee_academique
       FROM classe c
       LEFT JOIN filiere f ON f.id = c.filiere_id
       LEFT JOIN niveau n ON n.id = c.niveau_id
       LEFT JOIN anneeacademique aa ON aa.id = c.annee_academique_id
       WHERE ($1::int IS NULL OR c.annee_academique_id = $1)
       ${perim.clause}
       ORDER BY f.nom, n.ordre NULLS LAST, c.nom`,
      [annee_id || null, ...perim.params]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getMesClasses:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/**
 * Matières enseignables dans une classe : celles de la maquette pédagogique qui
 * correspond au triplet (filière, niveau, année) de la classe. Le CP planifie des cours,
 * il n'invente pas le programme — la liste vient donc de la maquette, pas d'une saisie libre.
 */
exports.getMatieresDeLaClasse = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT m.id, m.nom, m.code_ecue, m.coefficient, m.credits,
              m.volume_horaire_cm, m.volume_horaire_td,
              ue.libelle AS ue, s.nom AS semestre
       FROM classe c
       JOIN maquette mq ON mq.filiere_id = c.filiere_id
            AND mq.niveau_id = c.niveau_id
            AND mq.anneeacademique_id = c.annee_academique_id
       JOIN ue ON ue.maquette_id = mq.id
       JOIN matiere m ON m.ue_id = ue.id
       LEFT JOIN semestre s ON s.id = ue.semestre_id
       WHERE c.id = $1
       ORDER BY s.nom NULLS LAST, ue.libelle, m.nom`,
      [id]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getMatieresDeLaClasse:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/**
 * Enseignants planifiables par le CP : validés par les RH ET contractualisés pour
 * l'année (règle §4 « Contractualisation »). Les classes d'intervention prévues au
 * contrat sont renvoyées pour que l'interface puisse restreindre le choix en amont
 * plutôt que de laisser l'utilisateur se heurter à un refus à l'enregistrement.
 */
exports.getEnseignantsPlanifiables = async (req, res) => {
  try {
    const { annee_id } = req.query;
    if (!annee_id) {
      return res.status(400).json({ success: false, message: "L'année académique est requise." });
    }

    const result = await db.query(
      `SELECT e.id, e.matricule, e.nom, e.prenoms, e.grade, e.specialite,
              ct.id AS contrat_id, ct.taux_horaire, ct.volume_horaire_global, ct.type_contrat,
              COALESCE(
                ARRAY_AGG(cc.classe_id) FILTER (WHERE cc.classe_id IS NOT NULL),
                ARRAY[]::int[]
              ) AS classes_autorisees,
              COALESCE((
                SELECT SUM(EXTRACT(EPOCH FROM (s.heure_fin - s.heure_debut)) / 3600)
                FROM seance_edt s
                JOIN classe cl ON cl.id = s.classe_id
                WHERE s.enseignant_id = e.id AND s.statut <> 'annulee'
                  AND cl.annee_academique_id = ct.annee_academique_id
              ), 0)::numeric(10,1) AS heures_planifiees
       FROM enseignant e
       JOIN contrat_enseignant ct ON ct.enseignant_id = e.id
            AND ct.annee_academique_id = $1 AND ct.statut = 'actif'
       LEFT JOIN contrat_classe cc ON cc.contrat_id = ct.id
       WHERE e.statut = 'actif'
       GROUP BY e.id, ct.id
       ORDER BY e.nom, e.prenoms`,
      [annee_id]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getEnseignantsPlanifiables:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ---------------------------------------------------------------------------
//  Catalogue des besoins en enseignants (§3.1, Recrutement phase 1)
// ---------------------------------------------------------------------------

exports.getBesoins = async (req, res) => {
  try {
    const { annee_id, statut } = req.query;
    const perim = clausePerimetre(req, 'b.filiere_id', 'b.niveau_id', 3);

    const result = await db.query(
      `SELECT b.*, f.nom AS filiere, f.sigle, n.libelle AS niveau, m.nom AS matiere,
              aa.annee AS annee_academique, u.nom AS cree_par_nom,
              (SELECT COUNT(*)::int FROM offre_emploi_enseignant o WHERE o.besoin_id = b.id) AS nb_offres
       FROM besoin_enseignant b
       LEFT JOIN filiere f ON f.id = b.filiere_id
       LEFT JOIN niveau n ON n.id = b.niveau_id
       LEFT JOIN matiere m ON m.id = b.matiere_id
       LEFT JOIN anneeacademique aa ON aa.id = b.annee_academique_id
       LEFT JOIN utilisateur u ON u.id = b.cree_par
       WHERE ($1::int IS NULL OR b.annee_academique_id = $1)
         AND ($2::varchar IS NULL OR b.statut = $2)
       ${perim.clause}
       ORDER BY CASE b.priorite WHEN 'haute' THEN 1 WHEN 'normale' THEN 2 ELSE 3 END,
                b.created_at DESC`,
      [annee_id || null, statut || null, ...perim.params]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getBesoins:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.createBesoin = async (req, res) => {
  try {
    const {
      annee_academique_id, filiere_id, niveau_id, matiere_id, intitule,
      specialite_attendue, volume_horaire_prevu, nombre_postes, priorite, commentaire,
    } = req.body;

    if (!annee_academique_id || !filiere_id || !intitule?.trim()) {
      return res.status(400).json({ success: false, message: 'Année, filière et intitulé sont obligatoires.' });
    }

    const horsPerimetre = await verifierFiliereDansPerimetre(req, filiere_id, niveau_id);
    if (horsPerimetre) return res.status(403).json({ success: false, message: horsPerimetre });

    const result = await db.query(
      `INSERT INTO besoin_enseignant
         (annee_academique_id, filiere_id, niveau_id, matiere_id, intitule, specialite_attendue,
          volume_horaire_prevu, nombre_postes, priorite, commentaire, cree_par)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 0), COALESCE($8, 1), COALESCE($9, 'normale'), $10, $11)
       RETURNING *`,
      [
        annee_academique_id, filiere_id, niveau_id || null, matiere_id || null,
        intitule.trim(), specialite_attendue?.trim() || null,
        volume_horaire_prevu ?? null, nombre_postes ?? null, priorite || null,
        commentaire?.trim() || null, req.user.id,
      ]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur createBesoin:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.updateBesoin = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      filiere_id, niveau_id, matiere_id, intitule, specialite_attendue,
      volume_horaire_prevu, nombre_postes, priorite, commentaire,
    } = req.body;

    if (!filiere_id || !intitule?.trim()) {
      return res.status(400).json({ success: false, message: 'Filière et intitulé sont obligatoires.' });
    }
    const horsPerimetre = await verifierFiliereDansPerimetre(req, filiere_id, niveau_id);
    if (horsPerimetre) return res.status(403).json({ success: false, message: horsPerimetre });

    const result = await db.query(
      `UPDATE besoin_enseignant
       SET filiere_id = $1, niveau_id = $2, matiere_id = $3, intitule = $4,
           specialite_attendue = $5, volume_horaire_prevu = COALESCE($6, volume_horaire_prevu),
           nombre_postes = COALESCE($7, nombre_postes), priorite = COALESCE($8, priorite),
           commentaire = $9, updated_at = now()
       WHERE id = $10 RETURNING *`,
      [
        filiere_id, niveau_id || null, matiere_id || null, intitule.trim(),
        specialite_attendue?.trim() || null, volume_horaire_prevu ?? null,
        nombre_postes ?? null, priorite || null, commentaire?.trim() || null, id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Besoin introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur updateBesoin:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.setStatutBesoin = async (req, res) => {
  try {
    const { id } = req.params;
    const { statut } = req.body;
    if (!['ouvert', 'pourvu', 'annule'].includes(statut)) {
      return res.status(400).json({ success: false, message: "Statut invalide (ouvert, pourvu ou annule)." });
    }
    const result = await db.query(
      `UPDATE besoin_enseignant SET statut = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [statut, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Besoin introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur setStatutBesoin:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ---------------------------------------------------------------------------
//  Bannette de candidatures (§3.1 + workflow §4)
//  Le CP voit les candidatures dont au moins une filière visée relève de son périmètre.
// ---------------------------------------------------------------------------

const CLAUSE_FILIERE_CANDIDATURE = `EXISTS (
  SELECT 1 FROM candidature_filiere cf
  JOIN affectation_charge_pedagogique acp
    ON acp.filiere_id = cf.filiere_id AND acp.utilisateur_id = $%INDEX%
  WHERE cf.candidature_id = ce.id
)`;

exports.getCandidatures = async (req, res) => {
  try {
    const { statut } = req.query;
    const params = [statut || null];
    let filtrePerimetre = '';

    // L'admin et les RH voient tout ; le CP ne voit que ses filières.
    if (req.user.role === 'charge_pedagogique') {
      params.push(req.user.id);
      filtrePerimetre = ` AND ${CLAUSE_FILIERE_CANDIDATURE.replace('%INDEX%', params.length)}`;
    }

    const result = await db.query(
      `SELECT ce.id, ce.reference, ce.nom, ce.prenoms, ce.email, ce.telephone, ce.grade,
              ce.specialite, ce.annees_experience, ce.statut, ce.source, ce.cv_path,
              ce.created_at, ce.date_prevalidation, ce.commentaire_cp,
              o.titre AS offre_titre,
              COALESCE(
                ARRAY_AGG(DISTINCT f.nom) FILTER (WHERE f.nom IS NOT NULL),
                ARRAY[]::varchar[]
              ) AS filieres_visees
       FROM candidature_enseignant ce
       LEFT JOIN offre_emploi_enseignant o ON o.id = ce.offre_id
       LEFT JOIN candidature_filiere cf ON cf.candidature_id = ce.id
       LEFT JOIN filiere f ON f.id = cf.filiere_id
       WHERE ($1::varchar IS NULL OR ce.statut = $1)
       ${filtrePerimetre}
       GROUP BY ce.id, o.titre
       ORDER BY ce.created_at DESC`,
      params
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getCandidatures:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/** Profil complet du candidat (CV, spécialité, diplômes, filières) — §3.2. */
exports.getCandidature = async (req, res) => {
  try {
    const { id } = req.params;

    const candidature = await db.query(
      `SELECT ce.*, o.titre AS offre_titre, o.reference AS offre_reference,
              ucp.nom AS cp_evaluateur_nom, urh.nom AS rh_valideur_nom
       FROM candidature_enseignant ce
       LEFT JOIN offre_emploi_enseignant o ON o.id = ce.offre_id
       LEFT JOIN utilisateur ucp ON ucp.id = ce.cp_evaluateur_id
       LEFT JOIN utilisateur urh ON urh.id = ce.rh_valideur_id
       WHERE ce.id = $1`,
      [id]
    );
    if (candidature.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Candidature introuvable.' });
    }

    const [filieres, diplomes] = await Promise.all([
      db.query(
        `SELECT f.id, f.nom, f.sigle FROM candidature_filiere cf
         JOIN filiere f ON f.id = cf.filiere_id WHERE cf.candidature_id = $1`,
        [id]
      ),
      db.query(
        `SELECT id, intitule, etablissement, annee_obtention, fichier_path
         FROM candidature_diplome WHERE candidature_id = $1 ORDER BY annee_obtention DESC NULLS LAST`,
        [id]
      ),
    ]);

    res.status(200).json({
      success: true,
      data: { ...candidature.rows[0], filieres: filieres.rows, diplomes: diplomes.rows },
    });
  } catch (error) {
    console.error('Erreur getCandidature:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/**
 * Pré-évaluation du CP. Trois issues possibles :
 *   preselectionner → 'preselectionnee' (retenue, pas encore transmise)
 *   transmettre     → 'transmise_rh'    (entre dans la bannette RH)
 *   rejeter         → 'refusee'         (le CP écarte le dossier avant les RH)
 */
exports.evaluerCandidature = async (req, res) => {
  const ACTIONS = {
    preselectionner: 'preselectionnee',
    transmettre: 'transmise_rh',
    rejeter: 'refusee',
  };

  try {
    const { id } = req.params;
    const { action, commentaire } = req.body;
    const nouveauStatut = ACTIONS[action];

    if (!nouveauStatut) {
      return res.status(400).json({ success: false, message: 'Action invalide.' });
    }
    if (action === 'rejeter' && !commentaire?.trim()) {
      return res.status(400).json({ success: false, message: 'Un motif est requis pour écarter une candidature.' });
    }

    // Le motif de refus est le commentaire lui-même quand le CP écarte le dossier ; il est
    // résolu ici plutôt que par un CASE en SQL, où le même paramètre servait à la fois de
    // statut (varchar) et de motif (text) — PostgreSQL refusait d'en déduire un type unique.
    const commentaireNettoye = commentaire?.trim() || null;
    const motifRefus = nouveauStatut === 'refusee' ? commentaireNettoye : null;

    // Une candidature déjà tranchée par les RH ne doit plus pouvoir revenir en arrière
    // via la bannette du CP.
    const result = await db.query(
      `UPDATE candidature_enseignant
       SET statut = $1,
           commentaire_cp = COALESCE($2, commentaire_cp),
           motif_refus = COALESCE($3, motif_refus),
           cp_evaluateur_id = $4,
           date_prevalidation = now(),
           updated_at = now()
       WHERE id = $5 AND statut IN ('recue', 'preselectionnee')
       RETURNING *`,
      [nouveauStatut, commentaireNettoye, motifRefus, req.user.id, id]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Cette candidature n'est plus au stade de la pré-évaluation (déjà transmise ou traitée par les RH).",
      });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur evaluerCandidature:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ---------------------------------------------------------------------------
//  Tableau de bord
// ---------------------------------------------------------------------------

exports.getDashboard = async (req, res) => {
  try {
    const { annee_id } = req.query;
    if (!annee_id) {
      return res.status(400).json({ success: false, message: "L'année académique est requise." });
    }

    const perimBesoin = clausePerimetre(req, 'b.filiere_id', 'b.niveau_id', 2);
    const perimClasse = clausePerimetre(req, 'c.filiere_id', 'c.niveau_id', 2);
    const estCP = req.user.role === 'charge_pedagogique';

    const [besoins, classes, seances, sansSalle, candidatures, prochaines] = await Promise.all([
      db.query(
        `SELECT b.statut, COUNT(*)::int AS total, COALESCE(SUM(b.nombre_postes), 0)::int AS postes
         FROM besoin_enseignant b
         WHERE b.annee_academique_id = $1 ${perimBesoin.clause}
         GROUP BY b.statut`,
        [annee_id, ...perimBesoin.params]
      ),
      db.query(
        `SELECT COUNT(*)::int AS total FROM classe c
         WHERE c.annee_academique_id = $1 ${perimClasse.clause}`,
        [annee_id, ...perimClasse.params]
      ),
      db.query(
        `SELECT COUNT(*)::int AS total FROM seance_edt s
         JOIN classe c ON c.id = s.classe_id
         WHERE c.annee_academique_id = $1 AND s.statut <> 'annulee' ${perimClasse.clause}`,
        [annee_id, ...perimClasse.params]
      ),
      // Séances à venir sans salle : c'est l'action quotidienne du CP (« allocation au fur
      // et à mesure »), donc l'indicateur le plus utile de son tableau de bord.
      db.query(
        `SELECT COUNT(*)::int AS total FROM seance_edt s
         JOIN classe c ON c.id = s.classe_id
         WHERE c.annee_academique_id = $1 AND s.salle_id IS NULL
           AND s.statut <> 'annulee' AND s.date_seance >= CURRENT_DATE ${perimClasse.clause}`,
        [annee_id, ...perimClasse.params]
      ),
      db.query(
        `SELECT ce.statut, COUNT(*)::int AS total
         FROM candidature_enseignant ce
         WHERE ${estCP ? CLAUSE_FILIERE_CANDIDATURE.replace('%INDEX%', 1) : 'true'}
         GROUP BY ce.statut`,
        estCP ? [req.user.id] : []
      ),
      db.query(
        `SELECT s.id, s.date_seance, s.heure_debut, s.heure_fin, s.salle_id,
                c.nom AS classe, m.nom AS matiere, sa.code AS salle,
                e.nom AS enseignant_nom, e.prenoms AS enseignant_prenoms
         FROM seance_edt s
         JOIN classe c ON c.id = s.classe_id
         LEFT JOIN matiere m ON m.id = s.matiere_id
         LEFT JOIN salle sa ON sa.id = s.salle_id
         LEFT JOIN enseignant e ON e.id = s.enseignant_id
         WHERE c.annee_academique_id = $1 AND s.statut <> 'annulee'
           AND s.date_seance BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 ${perimClasse.clause}
         ORDER BY s.date_seance, s.heure_debut
         LIMIT 20`,
        [annee_id, ...perimClasse.params]
      ),
    ]);

    const parStatut = (rows) =>
      rows.reduce((acc, r) => ({ ...acc, [r.statut]: r.total }), {});

    res.status(200).json({
      success: true,
      data: {
        besoins: {
          par_statut: parStatut(besoins.rows),
          postes_ouverts: besoins.rows.find((r) => r.statut === 'ouvert')?.postes || 0,
        },
        classes: classes.rows[0].total,
        seances_planifiees: seances.rows[0].total,
        seances_sans_salle: sansSalle.rows[0].total,
        candidatures: parStatut(candidatures.rows),
        prochaines_seances: prochaines.rows,
      },
    });
  } catch (error) {
    console.error('Erreur getDashboard CP:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

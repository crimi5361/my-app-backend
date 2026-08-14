// Chantier Comptabilité — Priorité 1, point 3 (2026-08-13) : traçabilité des sorties d'argent.
// Table dédiée (migrations/sql/024_depenses_comptabilite.sql), pas de plan comptable/grand livre
// disproportionné — voir l'en-tête de cette migration pour la décision et sa justification.
const db = require('../config/db.config');

// ─── GET référentiel des catégories de dépenses (actives) ──────────────────
exports.getCategoriesDepense = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, code, libelle FROM categorie_depense WHERE actif = true ORDER BY libelle'
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getCategoriesDepense:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST enregistrer une dépense (statut initial ENREGISTREE) ─────────────
exports.creerDepense = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const {
      categorie_id, date_depense, montant, motif, beneficiaire,
      mode_paiement, reference_justificatif, annee_academique_id, caisse_id, commentaire,
    } = req.body;

    if (!categorie_id || !montant || !motif || !mode_paiement) {
      return res.status(400).json({
        success: false,
        message: 'Champs obligatoires manquants (catégorie, montant, motif, mode de paiement).',
      });
    }
    if (isNaN(parseFloat(montant)) || parseFloat(montant) <= 0) {
      return res.status(400).json({ success: false, message: 'Montant invalide.' });
    }

    const categorieResult = await db.query('SELECT id FROM categorie_depense WHERE id = $1 AND actif = true', [categorie_id]);
    if (categorieResult.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Catégorie de dépense invalide ou inactive.' });
    }

    const result = await db.query(
      `INSERT INTO depense (
         site_id, caisse_id, annee_academique_id, categorie_id, date_depense, montant, motif,
         beneficiaire, mode_paiement, reference_justificatif, commentaire, enregistre_par
       ) VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        siteId, caisse_id || null, annee_academique_id || null, categorie_id, date_depense || null,
        parseFloat(montant), motif, beneficiaire || null, mode_paiement, reference_justificatif || null,
        commentaire || null, req.user.id,
      ]
    );

    res.status(201).json({ success: true, message: 'Dépense enregistrée.', data: { id: result.rows[0].id } });
  } catch (error) {
    console.error('Erreur creerDepense:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET liste des dépenses (filtres : statut, catégorie, période, année académique) ────────
exports.listerDepenses = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const { statut, categorie_id, date_debut, date_fin, anneeAcademiqueId } = req.query;

    const conditions = ['d.site_id = $1'];
    const params = [siteId];

    if (statut) {
      params.push(statut);
      conditions.push(`d.statut = $${params.length}`);
    }
    if (categorie_id) {
      params.push(categorie_id);
      conditions.push(`d.categorie_id = $${params.length}`);
    }
    if (anneeAcademiqueId) {
      params.push(anneeAcademiqueId);
      conditions.push(`d.annee_academique_id = $${params.length}`);
    }
    if (date_debut) {
      params.push(date_debut);
      conditions.push(`d.date_depense >= $${params.length}`);
    }
    if (date_fin) {
      params.push(date_fin);
      conditions.push(`d.date_depense <= $${params.length}`);
    }

    const result = await db.query(
      `SELECT d.*, cd.code AS categorie_code, cd.libelle AS categorie_libelle,
              ue.nom AS enregistre_par_nom, uv.nom AS valide_par_nom, c.libelle AS caisse_libelle
       FROM depense d
       JOIN categorie_depense cd ON cd.id = d.categorie_id
       LEFT JOIN utilisateur ue ON ue.id = d.enregistre_par
       LEFT JOIN utilisateur uv ON uv.id = d.valide_par
       LEFT JOIN caisse c ON c.id = d.caisse_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY d.date_depense DESC, d.id DESC`,
      params
    );

    res.status(200).json({
      success: true,
      data: result.rows.map((r) => ({ ...r, montant: parseFloat(r.montant) })),
    });
  } catch (error) {
    console.error('Erreur listerDepenses:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── PUT valider une dépense (ENREGISTREE -> VALIDEE) ───────────────────────
exports.validerDepense = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE depense SET statut = 'VALIDEE', valide_par = $1, date_validation = now(), updated_at = now()
       WHERE id = $2 AND statut = 'ENREGISTREE'
       RETURNING id`,
      [req.user.id, id]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Dépense introuvable ou déjà traitée (seule une dépense ENREGISTREE peut être validée).",
      });
    }
    res.status(200).json({ success: true, message: 'Dépense validée.' });
  } catch (error) {
    console.error('Erreur validerDepense:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── PUT annuler une dépense (ENREGISTREE ou VALIDEE -> ANNULEE) ───────────
// Une dépense déjà validée peut aussi être annulée (erreur découverte après coup) — elle sort
// alors immédiatement du bilan (règle appliquée dans getBilan : uniquement statut = VALIDEE).
exports.annulerDepense = async (req, res) => {
  try {
    const { id } = req.params;
    const { motif_annulation } = req.body;
    if (!motif_annulation || !motif_annulation.trim()) {
      return res.status(400).json({ success: false, message: "Le motif d'annulation est obligatoire." });
    }

    const result = await db.query(
      `UPDATE depense SET statut = 'ANNULEE', motif_annulation = $1, updated_at = now()
       WHERE id = $2 AND statut != 'ANNULEE'
       RETURNING id`,
      [motif_annulation.trim(), id]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ success: false, message: 'Dépense introuvable ou déjà annulée.' });
    }
    res.status(200).json({ success: true, message: 'Dépense annulée.' });
  } catch (error) {
    console.error('Erreur annulerDepense:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET bilan entrées/sorties sur une période ──────────────────────────────
// Entrées = paiement (scolarité + autres, même distinction que la supervision caisse) +
// prise_en_charge validées sur la période. Sorties = UNIQUEMENT les dépenses VALIDEE (règle
// explicite : une dépense annulée n'entre jamais dans le bilan, une ENREGISTREE pas encore non
// plus — seule une décision validée compte comme une vraie sortie).
exports.getBilan = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const { date_debut, date_fin } = req.query;
    if (!date_debut || !date_fin) {
      return res.status(400).json({ success: false, message: 'Période requise (date_debut, date_fin).' });
    }

    const [entreesResult, pecResult, sortiesResult] = await Promise.all([
      db.query(
        `SELECT COALESCE(NULLIF(p.type_frais, ''), 'scolarite') AS type_frais,
                COUNT(*) AS nb, COALESCE(SUM(p.montant), 0) AS total
         FROM paiement p JOIN caisse c ON c.id = p.caisse_id
         WHERE c.site_id = $1 AND p.date_paiement BETWEEN $2 AND $3
         GROUP BY COALESCE(NULLIF(p.type_frais, ''), 'scolarite')
         ORDER BY total DESC`,
        [siteId, date_debut, date_fin]
      ),
      db.query(
        `SELECT COALESCE(SUM(p.montant_reduction), 0) AS total, COUNT(*) AS nb
         FROM prise_en_charge p JOIN etudiant e ON e.id = p.etudiant_id
         WHERE e.site_id = $1 AND p.statut = 'valide' AND p.date_validation BETWEEN $2 AND $3`,
        [siteId, date_debut, date_fin]
      ),
      db.query(
        `SELECT cd.code AS categorie_code, cd.libelle AS categorie_libelle,
                COUNT(*) AS nb, COALESCE(SUM(d.montant), 0) AS total
         FROM depense d JOIN categorie_depense cd ON cd.id = d.categorie_id
         WHERE d.site_id = $1 AND d.statut = 'VALIDEE' AND d.date_depense BETWEEN $2 AND $3
         GROUP BY cd.id, cd.code, cd.libelle
         ORDER BY total DESC`,
        [siteId, date_debut, date_fin]
      ),
    ]);

    const totalEntreesPaiements = entreesResult.rows.reduce((s, r) => s + parseFloat(r.total), 0);
    const totalPec = parseFloat(pecResult.rows[0].total);
    const totalEntrees = totalEntreesPaiements + totalPec;
    const totalSorties = sortiesResult.rows.reduce((s, r) => s + parseFloat(r.total), 0);

    res.status(200).json({
      success: true,
      data: {
        periode: { date_debut, date_fin },
        entrees: {
          par_type: entreesResult.rows.map((r) => ({ type_frais: r.type_frais, nb: parseInt(r.nb, 10), total: parseFloat(r.total) })),
          prises_en_charge: { total: totalPec, nb: parseInt(pecResult.rows[0].nb, 10) },
          total: totalEntrees,
        },
        sorties: {
          par_categorie: sortiesResult.rows.map((r) => ({
            categorie_code: r.categorie_code, categorie_libelle: r.categorie_libelle,
            nb: parseInt(r.nb, 10), total: parseFloat(r.total),
          })),
          total: totalSorties,
        },
        solde: totalEntrees - totalSorties,
      },
    });
  } catch (error) {
    console.error('Erreur getBilan:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

const db = require('../config/db.config');

// ─── GET toutes les années académiques (globales, IIPEA) ──────────────────
// Optionnellement filtrées/enrichies par site via ?site_id=
exports.getAllAnnees = async (req, res) => {
  try {
    const { site_id } = req.query;

    if (site_id) {
      const result = await db.query(
        `SELECT a.id, a.annee, s.etat, s.date_ouverture, s.date_fermeture
         FROM anneeacademique a
         LEFT JOIN anneeacademique_site s ON s.anneeacademique_id = a.id AND s.site_id = $1
         ORDER BY a.annee DESC`,
        [site_id]
      );
      return res.status(200).json(result.rows);
    }

    const result = await db.query(`SELECT id, annee FROM anneeacademique ORDER BY annee DESC`);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des annees:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── GET années "en cour" (globalement, ou pour un site si ?site_id=) ─────
exports.getAllAnneesValide = async (req, res) => {
  try {
    const { site_id } = req.query;
    const params = [];
    let query = `
      SELECT DISTINCT a.id, a.annee
      FROM anneeacademique a
      JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
      WHERE s.etat = 'en cour'
    `;
    if (site_id) {
      params.push(site_id);
      query += ` AND s.site_id = $${params.length}`;
    }
    query += ' ORDER BY a.annee DESC';
    const result = await db.query(query, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des annees en cours:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── GET l'année "en cour" pour un site précis ─────────────────────────────
exports.getAnneeEnCoursForSite = async (req, res) => {
  try {
    const { siteId } = req.params;
    const result = await db.query(
      `SELECT a.id, a.annee
       FROM anneeacademique a
       JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
       WHERE s.site_id = $1 AND s.etat = 'en cour'
       LIMIT 1`,
      [siteId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Aucune année académique en cours pour ce site." });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur getAnneeEnCoursForSite:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── POST créer une année académique globale (admin) ──────────────────────
exports.addAnnee = async (req, res) => {
  try {
    const { annee } = req.body;
    if (!annee) {
      return res.status(400).json({ message: "Le libellé de l'année est requis." });
    }

    const dupCheck = await db.query('SELECT id FROM anneeacademique WHERE annee = $1', [annee]);
    if (dupCheck.rows.length > 0) {
      return res.status(400).json({ message: `L'année ${annee} existe déjà.` });
    }

    const result = await db.query(
      'INSERT INTO anneeacademique (annee) VALUES ($1) RETURNING *',
      [annee]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur addAnnee:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── POST ouvrir une année académique pour un site (admin) ────────────────
exports.ouvrirAnneePourSite = async (req, res) => {
  try {
    const { anneeId, siteId } = req.params;

    const anneeCheck = await db.query('SELECT id FROM anneeacademique WHERE id = $1', [anneeId]);
    if (anneeCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Année académique introuvable.' });
    }

    const enCoursCheck = await db.query(
      `SELECT id FROM anneeacademique_site WHERE site_id = $1 AND etat = 'en cour'`,
      [siteId]
    );
    if (enCoursCheck.rows.length > 0) {
      return res.status(400).json({
        message: "Impossible d'ouvrir cette année : une autre année est déjà 'en cour' pour ce site. Fermez-la d'abord.",
      });
    }

    const existing = await db.query(
      'SELECT id FROM anneeacademique_site WHERE anneeacademique_id = $1 AND site_id = $2',
      [anneeId, siteId]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await db.query(
        `UPDATE anneeacademique_site SET etat = 'en cour', date_ouverture = now(), date_fermeture = NULL
         WHERE id = $1 RETURNING *`,
        [existing.rows[0].id]
      );
    } else {
      result = await db.query(
        `INSERT INTO anneeacademique_site (anneeacademique_id, site_id, etat, date_ouverture)
         VALUES ($1, $2, 'en cour', now()) RETURNING *`,
        [anneeId, siteId]
      );
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur ouvrirAnneePourSite:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── POST fermer une année académique pour un site ─────────────────────────
exports.fermerAnneePourSite = async (req, res) => {
  try {
    const { anneeId, siteId } = req.params;

    const result = await db.query(
      `UPDATE anneeacademique_site SET etat = 'terminée', date_fermeture = now()
       WHERE anneeacademique_id = $1 AND site_id = $2 RETURNING *`,
      [anneeId, siteId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Cette année n\'est pas ouverte pour ce site.' });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur fermerAnneePourSite:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ─── POST rouvrir une année académique pour un site ────────────────────────
exports.reouvrirAnneePourSite = async (req, res) => {
  try {
    const { anneeId, siteId } = req.params;

    const enCoursCheck = await db.query(
      `SELECT id FROM anneeacademique_site WHERE site_id = $1 AND etat = 'en cour' AND anneeacademique_id != $2`,
      [siteId, anneeId]
    );
    if (enCoursCheck.rows.length > 0) {
      return res.status(400).json({
        message: "Impossible de réouvrir : une autre année est déjà 'en cour' pour ce site. Fermez-la d'abord.",
      });
    }

    const result = await db.query(
      `UPDATE anneeacademique_site SET etat = 'en cour', date_ouverture = now(), date_fermeture = NULL
       WHERE anneeacademique_id = $1 AND site_id = $2 RETURNING *`,
      [anneeId, siteId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Cette année n\'a jamais été ouverte pour ce site.' });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur reouvrirAnneePourSite:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// Chantier "Orientations de réinscription LICENCE 2 PRO → LICENCE 3 PRO" (2026-08-29).
//
// CRUD admin pour la table `orientation_reinscription` — configure, pour un niveau LICENCE 2 PRO
// donné (origine), une ou plusieurs LICENCE 3 PRO de destination réellement existantes (ex. AD
// LICENCE 2 PRO → ADAF LICENCE 3 PRO, MAM LICENCE 3 PRO). AUCUNE donnée métier n'est déduite ni
// insérée automatiquement ici : uniquement le mécanisme permettant à l'administrateur de saisir
// ces orientations lui-même.
//
// La RÉSOLUTION des orientations pour la réinscription (agent + portail public) ne passe PAS par
// ce contrôleur : elle utilise `resoudreOrientationsNiveau`, exportée par
// `reinscription.controller.js` et appelée à l'identique par les deux — voir ce fichier.
//
// Protection : `role === 'admin'` strictement pour créer/modifier/supprimer (voir
// routes/orientationReinscription.routes.js, middleware authorizeRoles). La lecture (liste,
// niveaux candidats) est ouverte à tout utilisateur authentifié.
const db = require('../config/db.config');

// ─── GET liste complète des orientations configurées (écran admin) ─────────
exports.listerOrientations = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        orr.id, orr.niveau_origine_id, orr.niveau_destination_id, orr.created_at,
        no.libelle AS origine_niveau_libelle, ao.id AS origine_annee_id, ao.annee AS origine_annee,
        fo.id AS origine_filiere_id, fo.nom AS origine_filiere_nom, fo.sigle AS origine_filiere_sigle,
        nd.libelle AS destination_niveau_libelle, ad.id AS destination_annee_id, ad.annee AS destination_annee,
        fd.id AS destination_filiere_id, fd.nom AS destination_filiere_nom, fd.sigle AS destination_filiere_sigle,
        u.nom AS cree_par_nom
      FROM orientation_reinscription orr
      JOIN niveau no ON no.id = orr.niveau_origine_id
      JOIN filiere fo ON fo.id = no.filiere_id
      JOIN anneeacademique ao ON ao.id = no.anneeacademique_id
      JOIN niveau nd ON nd.id = orr.niveau_destination_id
      JOIN filiere fd ON fd.id = nd.filiere_id
      JOIN anneeacademique ad ON ad.id = nd.anneeacademique_id
      LEFT JOIN utilisateur u ON u.id = orr.cree_par
      ORDER BY fo.nom, ao.annee DESC, fd.nom
    `);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur listerOrientations:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET niveaux LICENCE 2 PRO candidats à l'origine (sélecteur du formulaire) ──
exports.listerNiveauxOrigine = async (req, res) => {
  try {
    const { anneeId } = req.query;
    const params = [];
    let whereAnnee = '';
    if (anneeId) {
      params.push(anneeId);
      whereAnnee = `AND n.anneeacademique_id = $${params.length}`;
    }
    const result = await db.query(`
      SELECT n.id AS niveau_id, n.libelle, n.anneeacademique_id, a.annee,
             f.id AS filiere_id, f.nom AS filiere_nom, f.sigle AS filiere_sigle
      FROM niveau n
      JOIN filiere f ON f.id = n.filiere_id
      JOIN anneeacademique a ON a.id = n.anneeacademique_id
      WHERE n.libelle = 'LICENCE 2 PRO' ${whereAnnee}
      ORDER BY a.annee DESC, f.nom
    `, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur listerNiveauxOrigine:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET niveaux LICENCE 3 PRO candidats à la destination (sélecteur du formulaire) ──
exports.listerNiveauxDestination = async (req, res) => {
  try {
    const { anneeId } = req.query;
    const params = [];
    let whereAnnee = '';
    if (anneeId) {
      params.push(anneeId);
      whereAnnee = `AND n.anneeacademique_id = $${params.length}`;
    }
    const result = await db.query(`
      SELECT n.id AS niveau_id, n.libelle, n.anneeacademique_id, a.annee,
             f.id AS filiere_id, f.nom AS filiere_nom, f.sigle AS filiere_sigle
      FROM niveau n
      JOIN filiere f ON f.id = n.filiere_id
      JOIN anneeacademique a ON a.id = n.anneeacademique_id
      WHERE n.libelle = 'LICENCE 3 PRO' ${whereAnnee}
      ORDER BY a.annee DESC, f.nom
    `, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur listerNiveauxDestination:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Validation partagée create/update — jamais de saisie libre : origine/destination doivent être
// des niveau.id réellement existants, respectivement LICENCE 2 PRO et LICENCE 3 PRO. Renvoie un
// message d'erreur (string) ou null si valide.
const validerOrigineDestination = async (niveauOrigineId, niveauDestinationId) => {
  if (!niveauOrigineId || !niveauDestinationId) {
    return 'niveau_origine_id et niveau_destination_id sont requis.';
  }
  if (parseInt(niveauOrigineId, 10) === parseInt(niveauDestinationId, 10)) {
    return "L'origine et la destination ne peuvent pas être le même niveau.";
  }
  const [origine, destination] = await Promise.all([
    db.query('SELECT id, libelle FROM niveau WHERE id = $1', [niveauOrigineId]),
    db.query('SELECT id, libelle FROM niveau WHERE id = $1', [niveauDestinationId]),
  ]);
  if (origine.rows.length === 0) return "Niveau d'origine introuvable.";
  if (destination.rows.length === 0) return 'Niveau de destination introuvable.';
  if (origine.rows[0].libelle !== 'LICENCE 2 PRO') {
    return "Le niveau d'origine doit être une LICENCE 2 PRO existante.";
  }
  if (destination.rows[0].libelle !== 'LICENCE 3 PRO') {
    return 'Le niveau de destination doit être une LICENCE 3 PRO existante.';
  }
  return null;
};

// ─── POST créer une orientation ─────────────────────────────────────────────
exports.creerOrientation = async (req, res) => {
  try {
    const { niveau_origine_id, niveau_destination_id } = req.body;
    const erreur = await validerOrigineDestination(niveau_origine_id, niveau_destination_id);
    if (erreur) return res.status(400).json({ success: false, message: erreur });

    const result = await db.query(
      `INSERT INTO orientation_reinscription (niveau_origine_id, niveau_destination_id, cree_par)
       VALUES ($1, $2, $3) RETURNING id, niveau_origine_id, niveau_destination_id, created_at`,
      [niveau_origine_id, niveau_destination_id, req.user?.id || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Cette orientation existe déjà.' });
    }
    console.error('Erreur creerOrientation:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── PUT modifier une orientation ───────────────────────────────────────────
exports.modifierOrientation = async (req, res) => {
  try {
    const { id } = req.params;
    const { niveau_origine_id, niveau_destination_id } = req.body;
    const erreur = await validerOrigineDestination(niveau_origine_id, niveau_destination_id);
    if (erreur) return res.status(400).json({ success: false, message: erreur });

    const result = await db.query(
      `UPDATE orientation_reinscription
       SET niveau_origine_id = $1, niveau_destination_id = $2
       WHERE id = $3
       RETURNING id, niveau_origine_id, niveau_destination_id, created_at`,
      [niveau_origine_id, niveau_destination_id, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Orientation introuvable.' });
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Cette orientation existe déjà.' });
    }
    console.error('Erreur modifierOrientation:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── DELETE supprimer une orientation ───────────────────────────────────────
exports.supprimerOrientation = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM orientation_reinscription WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Orientation introuvable.' });
    res.status(200).json({ success: true, message: 'Orientation supprimée.' });
  } catch (error) {
    console.error('Erreur supprimerOrientation:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

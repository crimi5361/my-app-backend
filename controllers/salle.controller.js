// Module Gestion des Enseignants (2026-08-11) — référentiel des salles physiques.
//
// Pas de suppression : une salle déjà utilisée par des séances passées ne doit jamais
// perdre son historique (même principe que le catalogue d'accessoires, Chantier 10).
// Désactivation via PATCH /:id/statut.
const db = require('../config/db.config');
const { sallesAvecDisponibilite } = require('../services/edtPlanification.service');

const CHAMPS = 'id, code, nom, site_id, batiment, etage, capacite, type_salle, equipements, statut, observations, created_at, updated_at';
// Même liste, préfixée, pour les requêtes qui joignent la table site.
const CHAMPS_PREFIXES = CHAMPS.split(', ').map((c) => `s.${c}`).join(', ');

exports.getSalles = async (req, res) => {
  try {
    const { site_id, statut } = req.query;
    const result = await db.query(
      `SELECT ${CHAMPS_PREFIXES}, si.nom AS site_nom
       FROM salle s
       JOIN site si ON si.id = s.site_id
       WHERE ($1::int IS NULL OR s.site_id = $1)
         AND ($2::varchar IS NULL OR s.statut = $2)
       ORDER BY si.nom, s.batiment NULLS LAST, s.code`,
      [site_id || null, statut || null]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getSalles:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.createSalle = async (req, res) => {
  try {
    const { code, nom, site_id, batiment, etage, capacite, type_salle, equipements, observations } = req.body;
    if (!code?.trim() || !nom?.trim() || !site_id) {
      return res.status(400).json({ success: false, message: 'Code, nom et site sont obligatoires.' });
    }

    const result = await db.query(
      `INSERT INTO salle (code, nom, site_id, batiment, etage, capacite, type_salle, equipements, observations)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'cours'), $8, $9)
       RETURNING ${CHAMPS}`,
      [
        code.trim().toUpperCase(), nom.trim(), site_id,
        batiment?.trim() || null, etage?.trim() || null,
        Number(capacite) || 0, type_salle || null,
        equipements?.trim() || null, observations?.trim() || null,
      ]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Une salle porte déjà ce code sur ce site.' });
    }
    console.error('Erreur createSalle:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.updateSalle = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, nom, site_id, batiment, etage, capacite, type_salle, equipements, observations } = req.body;
    if (!code?.trim() || !nom?.trim() || !site_id) {
      return res.status(400).json({ success: false, message: 'Code, nom et site sont obligatoires.' });
    }

    const result = await db.query(
      `UPDATE salle SET code = $1, nom = $2, site_id = $3, batiment = $4, etage = $5,
              capacite = $6, type_salle = COALESCE($7, type_salle), equipements = $8,
              observations = $9, updated_at = now()
       WHERE id = $10
       RETURNING ${CHAMPS}`,
      [
        code.trim().toUpperCase(), nom.trim(), site_id,
        batiment?.trim() || null, etage?.trim() || null,
        Number(capacite) || 0, type_salle || null,
        equipements?.trim() || null, observations?.trim() || null, id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Salle introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Une salle porte déjà ce code sur ce site.' });
    }
    console.error('Erreur updateSalle:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.setStatutSalle = async (req, res) => {
  try {
    const { id } = req.params;
    const { statut } = req.body;
    if (!['actif', 'inactif'].includes(statut)) {
      return res.status(400).json({ success: false, message: "Le statut doit être 'actif' ou 'inactif'." });
    }

    // Désactiver une salle encore réservée sur des séances à venir laisserait des cours
    // planifiés dans un local qui n'est plus censé être utilisable : on l'annonce plutôt
    // que de le découvrir le jour du cours.
    if (statut === 'inactif') {
      const aVenir = await db.query(
        `SELECT COUNT(*)::int AS total FROM seance_edt
         WHERE salle_id = $1 AND date_seance >= CURRENT_DATE AND statut <> 'annulee'`,
        [id]
      );
      if (aVenir.rows[0].total > 0) {
        return res.status(409).json({
          success: false,
          message: `Cette salle est encore affectée à ${aVenir.rows[0].total} séance(s) à venir. Réaffectez-les avant de la désactiver.`,
        });
      }
    }

    const result = await db.query(
      `UPDATE salle SET statut = $1, updated_at = now() WHERE id = $2
       RETURNING ${CHAMPS}`,
      [statut, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Salle introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur setStatutSalle:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/**
 * Disponibilité des salles sur un créneau — alimente le sélecteur de salle du Chargé
 * Pédagogique, qui grise les salles occupées (règle §4).
 */
exports.getDisponibilite = async (req, res) => {
  try {
    const { date, heure_debut, heure_fin, site_id, exclure_seance_id } = req.query;
    if (!date || !heure_debut || !heure_fin) {
      return res.status(400).json({ success: false, message: 'date, heure_debut et heure_fin sont requis.' });
    }

    const data = await sallesAvecDisponibilite({
      site_id: site_id ? Number(site_id) : req.user?.departement_id,
      date_seance: date,
      heure_debut,
      heure_fin,
      exclure_seance_id: exclure_seance_id ? Number(exclure_seance_id) : null,
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Erreur getDisponibilite:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

/** Taux d'occupation par salle sur une période — vue de pilotage du CP. */
exports.getOccupation = async (req, res) => {
  try {
    const { date_debut, date_fin, site_id } = req.query;
    if (!date_debut || !date_fin) {
      return res.status(400).json({ success: false, message: 'date_debut et date_fin sont requis.' });
    }

    const result = await db.query(
      `SELECT sa.id, sa.code, sa.nom, sa.capacite,
              COUNT(s.id)::int AS nb_seances,
              COALESCE(SUM(EXTRACT(EPOCH FROM (s.heure_fin - s.heure_debut)) / 3600), 0)::numeric(10,1) AS heures_occupees
       FROM salle sa
       LEFT JOIN seance_edt s ON s.salle_id = sa.id
            AND s.date_seance BETWEEN $1 AND $2 AND s.statut <> 'annulee'
       WHERE sa.statut = 'actif' AND ($3::int IS NULL OR sa.site_id = $3)
       GROUP BY sa.id
       ORDER BY heures_occupees DESC, sa.code`,
      [date_debut, date_fin, site_id ? Number(site_id) : req.user?.departement_id || null]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getOccupation:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

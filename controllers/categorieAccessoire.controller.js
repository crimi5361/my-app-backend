// Chantier Moyens Généraux — Phase 2A (2026-08-19) : catégories du catalogue d'accessoires.
//
// Même patron que accessoire.controller.js : pas de suppression physique (une catégorie déjà
// affectée à des accessoires ne peut pas être retirée sans casser cette référence) — désactivation
// (`actif = false`) uniquement, via un endpoint dédié.
const db = require('../config/db.config');

const COLONNES = 'id, nom, description, actif, created_at, updated_at';

exports.getCategories = async (req, res) => {
  try {
    const result = await db.query(`SELECT ${COLONNES} FROM categorie_accessoire ORDER BY nom`);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getCategories:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.createCategorie = async (req, res) => {
  try {
    const { nom, description } = req.body;
    if (!nom || !nom.trim()) {
      return res.status(400).json({ success: false, message: 'Le nom est obligatoire.' });
    }
    const result = await db.query(
      `INSERT INTO categorie_accessoire (nom, description) VALUES ($1, $2) RETURNING ${COLONNES}`,
      [nom.trim(), description?.trim() || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Une catégorie avec ce nom existe déjà.' });
    }
    console.error('Erreur createCategorie:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.updateCategorie = async (req, res) => {
  try {
    const { id } = req.params;
    const { nom, description } = req.body;
    if (!nom || !nom.trim()) {
      return res.status(400).json({ success: false, message: 'Le nom est obligatoire.' });
    }
    const result = await db.query(
      `UPDATE categorie_accessoire SET nom = $1, description = $2, updated_at = now() WHERE id = $3 RETURNING ${COLONNES}`,
      [nom.trim(), description?.trim() || null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Catégorie introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Une catégorie avec ce nom existe déjà.' });
    }
    console.error('Erreur updateCategorie:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.setStatutCategorie = async (req, res) => {
  try {
    const { id } = req.params;
    const { actif } = req.body;
    if (typeof actif !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Le champ actif (booléen) est requis.' });
    }
    const result = await db.query(
      `UPDATE categorie_accessoire SET actif = $1, updated_at = now() WHERE id = $2 RETURNING ${COLONNES}`,
      [actif, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Catégorie introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur setStatutCategorie:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Chantier 10 (2026-08-02) — sous-phase 5 : référentiel des fournisseurs.
//
// Même principe que le catalogue d'accessoires (sous-phase 4) : pas de suppression physique — un
// fournisseur déjà rattaché à une commande (sous-phase 6) ne doit jamais perdre son historique.
// Désactivation via un endpoint dédié.
const db = require('../config/db.config');

const COLONNES = 'id, nom, contact_nom, telephone, email, adresse, ville, observations, statut, created_at, updated_at';

exports.getFournisseurs = async (req, res) => {
  try {
    const result = await db.query(`SELECT ${COLONNES} FROM fournisseur ORDER BY nom`);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getFournisseurs:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.createFournisseur = async (req, res) => {
  try {
    const { nom, contact_nom, telephone, email, adresse, ville, observations } = req.body;
    if (!nom || !nom.trim()) {
      return res.status(400).json({ success: false, message: 'Le nom du fournisseur est obligatoire.' });
    }

    const result = await db.query(
      `INSERT INTO fournisseur (nom, contact_nom, telephone, email, adresse, ville, observations)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLONNES}`,
      [
        nom.trim(),
        contact_nom?.trim() || null,
        telephone?.trim() || null,
        email?.trim() || null,
        adresse?.trim() || null,
        ville?.trim() || null,
        observations?.trim() || null,
      ]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: fournisseurMessageDoublon(error) });
    }
    console.error('Erreur createFournisseur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.updateFournisseur = async (req, res) => {
  try {
    const { id } = req.params;
    const { nom, contact_nom, telephone, email, adresse, ville, observations } = req.body;
    if (!nom || !nom.trim()) {
      return res.status(400).json({ success: false, message: 'Le nom du fournisseur est obligatoire.' });
    }

    const result = await db.query(
      `UPDATE fournisseur
       SET nom = $1, contact_nom = $2, telephone = $3, email = $4, adresse = $5, ville = $6, observations = $7, updated_at = now()
       WHERE id = $8
       RETURNING ${COLONNES}`,
      [
        nom.trim(),
        contact_nom?.trim() || null,
        telephone?.trim() || null,
        email?.trim() || null,
        adresse?.trim() || null,
        ville?.trim() || null,
        observations?.trim() || null,
        id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fournisseur introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: fournisseurMessageDoublon(error) });
    }
    console.error('Erreur updateFournisseur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.setStatutFournisseur = async (req, res) => {
  try {
    const { id } = req.params;
    const { statut } = req.body;
    if (!['actif', 'inactif'].includes(statut)) {
      return res.status(400).json({ success: false, message: "Le statut doit être 'actif' ou 'inactif'." });
    }
    const result = await db.query(
      `UPDATE fournisseur SET statut = $1, updated_at = now() WHERE id = $2 RETURNING ${COLONNES}`,
      [statut, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Fournisseur introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur setStatutFournisseur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Le nom de la contrainte violée renseigne quel champ est en doublon (nom/téléphone/email) —
// message précis plutôt qu'un message générique qui obligerait l'utilisateur à deviner.
function fournisseurMessageDoublon(error) {
  if (error.constraint === 'fournisseur_nom_key') return 'Un fournisseur avec ce nom existe déjà.';
  if (error.constraint === 'fournisseur_telephone_key') return 'Ce numéro de téléphone est déjà utilisé par un autre fournisseur.';
  if (error.constraint === 'fournisseur_email_key') return 'Cet email est déjà utilisé par un autre fournisseur.';
  return 'Ce fournisseur existe déjà.';
}

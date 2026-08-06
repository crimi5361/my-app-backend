// Chantier 10 (2026-08-02) — sous-phase 4 : catalogue des accessoires (référentiel).
// Complété sous-phase 8 : coût unitaire de référence (valorisation du stock).
//
// Pas de suppression physique — un accessoire déjà utilisé dans une commande/distribution ne peut
// pas être retiré sans casser l'historique (grand-livre). Désactivation (`actif = false`)
// uniquement, via un endpoint dédié pour rendre cette action explicite côté UI (un bouton
// "Désactiver" ne doit pas pouvoir écraser silencieusement les autres champs).
const db = require('../config/db.config');

const COLONNES = 'id, code, nom, description, actif, seuil_alerte_defaut, cout_unitaire_reference, created_at, updated_at';

function validerCoutUnitaire(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return { ok: true, valeur: null };
  const nombre = parseFloat(valeur);
  if (Number.isNaN(nombre) || nombre < 0) return { ok: false };
  return { ok: true, valeur: Math.round(nombre * 100) / 100 };
}

exports.getAccessoires = async (req, res) => {
  try {
    const result = await db.query(`SELECT ${COLONNES} FROM accessoire ORDER BY nom`);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getAccessoires:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.createAccessoire = async (req, res) => {
  try {
    const { code, nom, description, seuil_alerte_defaut, cout_unitaire_reference } = req.body;
    if (!code || !code.trim() || !nom || !nom.trim()) {
      return res.status(400).json({ success: false, message: 'Le code et le nom sont obligatoires.' });
    }
    const seuil = seuil_alerte_defaut !== undefined && seuil_alerte_defaut !== null ? parseInt(seuil_alerte_defaut, 10) : 0;
    if (Number.isNaN(seuil) || seuil < 0) {
      return res.status(400).json({ success: false, message: 'Le seuil d\'alerte doit être un entier positif ou nul.' });
    }
    const cout = validerCoutUnitaire(cout_unitaire_reference);
    if (!cout.ok) {
      return res.status(400).json({ success: false, message: 'Le coût unitaire de référence doit être un nombre positif ou nul.' });
    }

    const result = await db.query(
      `INSERT INTO accessoire (code, nom, description, seuil_alerte_defaut, cout_unitaire_reference)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLONNES}`,
      [code.trim(), nom.trim(), description?.trim() || null, seuil, cout.valeur]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Un accessoire avec ce code ou ce nom existe déjà.' });
    }
    console.error('Erreur createAccessoire:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.updateAccessoire = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, nom, description, seuil_alerte_defaut, cout_unitaire_reference } = req.body;
    if (!code || !code.trim() || !nom || !nom.trim()) {
      return res.status(400).json({ success: false, message: 'Le code et le nom sont obligatoires.' });
    }
    const seuil = seuil_alerte_defaut !== undefined && seuil_alerte_defaut !== null ? parseInt(seuil_alerte_defaut, 10) : 0;
    if (Number.isNaN(seuil) || seuil < 0) {
      return res.status(400).json({ success: false, message: 'Le seuil d\'alerte doit être un entier positif ou nul.' });
    }
    const cout = validerCoutUnitaire(cout_unitaire_reference);
    if (!cout.ok) {
      return res.status(400).json({ success: false, message: 'Le coût unitaire de référence doit être un nombre positif ou nul.' });
    }

    const result = await db.query(
      `UPDATE accessoire
       SET code = $1, nom = $2, description = $3, seuil_alerte_defaut = $4, cout_unitaire_reference = $5, updated_at = now()
       WHERE id = $6
       RETURNING ${COLONNES}`,
      [code.trim(), nom.trim(), description?.trim() || null, seuil, cout.valeur, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Accessoire introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Un accessoire avec ce code ou ce nom existe déjà.' });
    }
    console.error('Erreur updateAccessoire:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.setStatutAccessoire = async (req, res) => {
  try {
    const { id } = req.params;
    const { actif } = req.body;
    if (typeof actif !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Le champ actif (booléen) est requis.' });
    }
    const result = await db.query(
      `UPDATE accessoire SET actif = $1, updated_at = now() WHERE id = $2 RETURNING ${COLONNES}`,
      [actif, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Accessoire introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur setStatutAccessoire:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

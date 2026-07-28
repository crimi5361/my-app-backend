const db = require('../config/db.config');

exports.getAllEtablissements = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, nom_etablissement, situation_geographique, statut, dren, created_at, updated_at FROM public.etablissement_origine ORDER BY nom_etablissement'
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des établissements d\'origine:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.getEtablissementById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT id, nom_etablissement, situation_geographique, statut, dren, created_at, updated_at FROM public.etablissement_origine WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Établissement introuvable.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la récupération de l\'établissement:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.createEtablissement = async (req, res) => {
  try {
    const { nom_etablissement, situation_geographique, statut, dren } = req.body;
    if (!nom_etablissement) {
      return res.status(400).json({ message: 'Le nom de l\'établissement est obligatoire.' });
    }
    const result = await db.query(
      `INSERT INTO public.etablissement_origine (nom_etablissement, situation_geographique, statut, dren)
       VALUES ($1, $2, COALESCE($3, 'PUBLIC'), $4)
       RETURNING id, nom_etablissement, situation_geographique, statut, dren, created_at, updated_at`,
      [nom_etablissement, situation_geographique || null, statut || null, dren || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la création de l\'établissement:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.updateEtablissement = async (req, res) => {
  try {
    const { id } = req.params;
    const { nom_etablissement, situation_geographique, statut, dren } = req.body;
    if (!nom_etablissement) {
      return res.status(400).json({ message: 'Le nom de l\'établissement est obligatoire.' });
    }
    const result = await db.query(
      `UPDATE public.etablissement_origine
       SET nom_etablissement = $1, situation_geographique = $2, statut = COALESCE($3, statut), dren = $4, updated_at = now()
       WHERE id = $5
       RETURNING id, nom_etablissement, situation_geographique, statut, dren, created_at, updated_at`,
      [nom_etablissement, situation_geographique || null, statut || null, dren || null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Établissement introuvable.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la mise à jour de l\'établissement:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.deleteEtablissement = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM public.etablissement_origine WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Établissement introuvable.' });
    }
    res.status(200).json({ message: 'Établissement supprimé.' });
  } catch (error) {
    console.error('Erreur lors de la suppression de l\'établissement:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

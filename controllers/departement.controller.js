const db = require('../config/db.config');

// Département académique (Droit, Management, Communication...), rattaché à une école.
exports.getAllDepartements = async (req, res) => {
  try {
    const { ecole_id } = req.query;
    const params = [];
    let query = `
      SELECT d.id, d.nom, d.sigle, d.ecole_id, d.created_at, e.nom AS ecole_nom
      FROM public.departement d
      JOIN public.ecole e ON e.id = d.ecole_id
    `;
    if (ecole_id) {
      params.push(ecole_id);
      query += ` WHERE d.ecole_id = $${params.length}`;
    }
    query += ' ORDER BY d.nom';
    const result = await db.query(query, params);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des départements:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.getDepartementById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT d.id, d.nom, d.sigle, d.ecole_id, d.created_at, e.nom AS ecole_nom
       FROM public.departement d
       JOIN public.ecole e ON e.id = d.ecole_id
       WHERE d.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Département introuvable.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la récupération du département:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.createDepartement = async (req, res) => {
  try {
    const { nom, sigle, ecole_id } = req.body;
    if (!nom || !ecole_id) {
      return res.status(400).json({ message: 'Le nom et l\'école du département sont obligatoires.' });
    }
    const result = await db.query(
      'INSERT INTO public.departement (nom, sigle, ecole_id) VALUES ($1, $2, $3) RETURNING id, nom, sigle, ecole_id, created_at',
      [nom, sigle || null, ecole_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Ce département existe déjà pour cette école.' });
    }
    console.error('Erreur lors de la création du département:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.updateDepartement = async (req, res) => {
  try {
    const { id } = req.params;
    const { nom, sigle, ecole_id } = req.body;
    if (!nom || !ecole_id) {
      return res.status(400).json({ message: 'Le nom et l\'école du département sont obligatoires.' });
    }
    const result = await db.query(
      'UPDATE public.departement SET nom = $1, sigle = $2, ecole_id = $3 WHERE id = $4 RETURNING id, nom, sigle, ecole_id, created_at',
      [nom, sigle || null, ecole_id, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Département introuvable.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Ce département existe déjà pour cette école.' });
    }
    console.error('Erreur lors de la mise à jour du département:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.deleteDepartement = async (req, res) => {
  try {
    const { id } = req.params;
    const enUsage = await db.query('SELECT 1 FROM public.filiere WHERE departement_id = $1 LIMIT 1', [id]);
    if (enUsage.rows.length > 0) {
      return res.status(409).json({ message: 'Impossible de supprimer ce département : des filières y sont rattachées.' });
    }
    const result = await db.query('DELETE FROM public.departement WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Département introuvable.' });
    }
    res.status(200).json({ message: 'Département supprimé.' });
  } catch (error) {
    console.error('Erreur lors de la suppression du département:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const db = require('../config/db.config');

exports.getAllEcoles = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, nom, code, description, statut, created_at, updated_at FROM public.ecole ORDER BY nom'
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des écoles:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.getEcoleById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT id, nom, code, description, statut, created_at, updated_at FROM public.ecole WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'École introuvable.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la récupération de l\'école:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.createEcole = async (req, res) => {
  try {
    const { nom, code, description, statut } = req.body;
    if (!nom || !code) {
      return res.status(400).json({ message: 'Le nom et le code de l\'école sont obligatoires.' });
    }
    const result = await db.query(
      `INSERT INTO public.ecole (nom, code, description, statut)
       VALUES ($1, $2, $3, COALESCE($4, 'actif'))
       RETURNING id, nom, code, description, statut, created_at, updated_at`,
      [nom, code, description || null, statut || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Ce code ou ce nom d\'école existe déjà.' });
    }
    console.error('Erreur lors de la création de l\'école:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.updateEcole = async (req, res) => {
  try {
    const { id } = req.params;
    const { nom, code, description, statut } = req.body;
    if (!nom || !code) {
      return res.status(400).json({ message: 'Le nom et le code de l\'école sont obligatoires.' });
    }
    const result = await db.query(
      `UPDATE public.ecole
       SET nom = $1, code = $2, description = $3, statut = COALESCE($4, statut), updated_at = now()
       WHERE id = $5
       RETURNING id, nom, code, description, statut, created_at, updated_at`,
      [nom, code, description || null, statut || null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'École introuvable.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Ce code ou ce nom d\'école existe déjà.' });
    }
    console.error('Erreur lors de la mise à jour de l\'école:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.deleteEcole = async (req, res) => {
  try {
    const { id } = req.params;
    const enUsage = await db.query('SELECT 1 FROM public.departement WHERE ecole_id = $1 LIMIT 1', [id]);
    if (enUsage.rows.length > 0) {
      return res.status(409).json({ message: 'Impossible de supprimer cette école : des départements y sont rattachés.' });
    }
    const result = await db.query('DELETE FROM public.ecole WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'École introuvable.' });
    }
    res.status(200).json({ message: 'École supprimée.' });
  } catch (error) {
    console.error('Erreur lors de la suppression de l\'école:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const db = require('../config/db.config');

// Récupérer tous les sites (ex-"départements" physiques : campus IIPEA)
exports.getAllSites = async (req, res) => {
  try {
    const result = await db.query('SELECT id, nom, adresse FROM public.site ORDER BY nom');
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des sites:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.getSiteById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT id, nom, adresse FROM public.site WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Site introuvable.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la récupération du site:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.createSite = async (req, res) => {
  try {
    const { nom, adresse } = req.body;
    if (!nom) {
      return res.status(400).json({ message: 'Le nom du site est obligatoire.' });
    }
    const result = await db.query(
      'INSERT INTO public.site (nom, adresse) VALUES ($1, $2) RETURNING id, nom, adresse',
      [nom, adresse || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la création du site:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.updateSite = async (req, res) => {
  try {
    const { id } = req.params;
    const { nom, adresse } = req.body;
    if (!nom) {
      return res.status(400).json({ message: 'Le nom du site est obligatoire.' });
    }
    const result = await db.query(
      'UPDATE public.site SET nom = $1, adresse = $2 WHERE id = $3 RETURNING id, nom, adresse',
      [nom, adresse || null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Site introuvable.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la mise à jour du site:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.deleteSite = async (req, res) => {
  try {
    const { id } = req.params;
    const enUsage = await db.query(
      'SELECT 1 FROM public.etudiant WHERE site_id = $1 UNION ALL SELECT 1 FROM public.utilisateur WHERE site_id = $1 UNION ALL SELECT 1 FROM public.niveau WHERE site_id = $1 LIMIT 1',
      [id]
    );
    if (enUsage.rows.length > 0) {
      return res.status(409).json({ message: 'Impossible de supprimer ce site : des étudiants, utilisateurs ou niveaux y sont rattachés.' });
    }
    const result = await db.query('DELETE FROM public.site WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Site introuvable.' });
    }
    res.status(200).json({ message: 'Site supprimé.' });
  } catch (error) {
    console.error('Erreur lors de la suppression du site:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

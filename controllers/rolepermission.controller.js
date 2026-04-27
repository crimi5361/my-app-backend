const db = require('../config/db.config');

// Associer plusieurs permissions à un rôle
exports.attribuerPermissionsARole = async (req, res) => {
  const { role_id, permission_ids } = req.body;

  if (!role_id || !Array.isArray(permission_ids)) {
    return res.status(400).json({ message: "role_id et permission_ids (array) sont requis." });
  }

  try {
    // Supprimer les anciennes associations du rôle
    await db.query('DELETE FROM rolepermission WHERE role_id = $1', [role_id]);

    // Insérer les nouvelles associations
    const insertPromises = permission_ids.map((permission_id) => {
      return db.query(
        'INSERT INTO rolepermission (role_id, permission_id) VALUES ($1, $2)',
        [role_id, permission_id]
      );
    });

    await Promise.all(insertPromises);

    res.status(200).json({ message: 'Permissions mises à jour avec succès.' });
  } catch (error) {
    console.error('Erreur lors de l’association des permissions:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// Récupérer toutes les permissions liées à un rôle
exports.getPermissionsByRoleId = async (req, res) => {
  const { role_id } = req.params;

  try {
    const result = await db.query(
      `SELECT p.id, p.nom, p.description
       FROM rolepermission rp
       JOIN permission p ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [role_id]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des permissions du rôle:', error);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

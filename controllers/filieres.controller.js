const db = require('../config/db.config');

exports.getAllFilieres = async (req, res) => {
    try {
        const result = await db.query(`
           SELECT id, nom, sigle, type_filiere_id
	         FROM filiere
    `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des filieres:', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
};
//=====================================================================================

exports.getAllFilieresTable = async (req, res) => {
    try {
        const result = await db.query(`
           SELECT 
    f.id,
    f.nom,
    f.sigle,
    tf.id AS typefiliere_id,
    tf.libelle AS typefiliere_libelle,
    tf.description AS typefiliere_description
FROM public.filiere f
JOIN public.typefiliere tf 
    ON f.type_filiere_id = tf.id;
    `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Erreur lors de la récupération des filieres:', error);
        res.status(500).json({ message: 'Erreur serveur.' });
    }
};

//=====================================================================================

// Ajouter une filière avec ses niveaux
exports.createFiliereAvecNiveaux = async (req, res) => {
  const { nom, sigle, type_filiere_id, niveaux } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Insérer la filière
    const insertFiliereQuery = `
      INSERT INTO filiere (nom, sigle, type_filiere_id)
      VALUES ($1, $2, $3)
      RETURNING id
    `;
    const filiereResult = await client.query(insertFiliereQuery, [nom, sigle, type_filiere_id]);
    const filiereId = filiereResult.rows[0].id;

    // 2. Insérer les niveaux associés
    const insertNiveauQuery = `
      INSERT INTO niveau (libelle, prix_formation, type_filiere, filiere_id)
      VALUES ($1, $2, $3, $4)
    `;

    for (const niveau of niveaux) {
      const { libelle, prix_formation } = niveau;
      await client.query(insertNiveauQuery, [libelle, prix_formation, type_filiere_id, filiereId]);
    }

    await client.query('COMMIT');

    res.status(201).json({ message: 'Filière et niveaux ajoutés avec succès', id: filiereId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur lors de l’ajout de la filière avec niveaux :', error);
    res.status(500).json({ message: 'Erreur serveur lors de l’ajout de la filière' });
  } finally {
    client.release();
  }
};
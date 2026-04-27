const db = require('../config/db.config');

exports.createUE = async (req, res) => {
  try {
    const { libelle, semestre_id, categorie_id, maquette_id } = req.body;
    
    // Validation des données
    if (!libelle || !semestre_id || !categorie_id || !maquette_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Tous les champs sont requis' 
      });
    }
    
    const query = `
      INSERT INTO ue (libelle, semestre_id, categorie_id, maquette_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    
    const values = [libelle, semestre_id, categorie_id, maquette_id];
    const result = await db.query(query, values); // Changé pool.query en db.query
    
    res.status(201).json({ 
      success: true, 
      message: 'UE créée avec succès',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Erreur lors de la création de l\'UE:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};


// exports.getAllUes = async (req, res) => {
//   try {
//     const result = await db.query('SELECT id, libelle FROM ue');
//     res.json(result.rows);
//   } catch (error) {
//     console.error('Erreur lors de la récupération des UEs:', error);
//     res.status(500).json({ success: false, message: 'Erreur serveur' });
//   }
// };
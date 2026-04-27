const db = require('../config/db.config');

// Créer une matière
exports.createMatiere = async (req, res) => {
  try {
    const {
      nom,
      coefficient,
      ue_id,
      taux_horaire_cm = 0,   
      volume_horaire_td = 0, 
      taux_horaire_td = 0,   
      volume_horaire_cm = 0, 
    } = req.body;
    
    // Validation des données - seulement les champs vraiment obligatoires
    if (!nom || !coefficient || !ue_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Les champs nom, coefficient et ue_id sont requis' 
      });
    }
    
    const query = `
      INSERT INTO matiere (
        nom, coefficient, ue_id, volume_horaire_cm, 
        taux_horaire_cm, volume_horaire_td, taux_horaire_td
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    
    const values = [
      nom,
      coefficient,
      ue_id,
      volume_horaire_cm,
      taux_horaire_cm,
      volume_horaire_td,
      taux_horaire_td,
    ];
    
    const result = await db.query(query, values);
    
    res.status(201).json({ 
      success: true, 
      message: 'Matière créée avec succès',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Erreur lors de la création de la matière:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};
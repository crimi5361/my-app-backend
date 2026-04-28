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
      code_ecue
    } = req.body;
    
    // Validation des données - seulement les champs vraiment obligatoires
    if (!nom || !coefficient || !ue_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Les champs nom, coefficient et ue_id sont requis' 
      });
    }
    
    // Validation du code_ecue (optionnel mais recommandé)
    if (code_ecue) {
      // Vérifier si le code existe déjà
      const checkQuery = 'SELECT id FROM matiere WHERE code_ecue = $1';
      const checkResult = await db.query(checkQuery, [code_ecue]);
      
      if (checkResult.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Ce code ECUE existe déjà'
        });
      }
    }
    
    const query = `
      INSERT INTO matiere (
        nom, coefficient, ue_id, volume_horaire_cm, 
        taux_horaire_cm, volume_horaire_td, taux_horaire_td,
        code_ecue
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
      code_ecue || null
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

///============================================

// matiere.controller.js

exports.updateMatiere = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nom,
      coefficient,
      code_ecue,
      volume_horaire_cm = 0,
      taux_horaire_cm   = 0,
      volume_horaire_td = 0,
      taux_horaire_td   = 0,
    } = req.body;

    if (!nom || coefficient === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Les champs nom et coefficient sont requis'
      });
    }

    // Vérifier si le code_ecue est déjà pris par une AUTRE matière
    if (code_ecue) {
      const checkQuery = 'SELECT id FROM matiere WHERE code_ecue = $1 AND id != $2';
      const checkResult = await db.query(checkQuery, [code_ecue, id]);

      if (checkResult.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Ce code ECUE est déjà utilisé par une autre matière'
        });
      }
    }

    const query = `
      UPDATE matiere
      SET nom               = $1,
          coefficient       = $2,
          code_ecue         = $3,
          volume_horaire_cm = $4,
          taux_horaire_cm   = $5,
          volume_horaire_td = $6,
          taux_horaire_td   = $7
      WHERE id = $8
      RETURNING *
    `;

    const result = await db.query(query, [
      nom,
      coefficient,
      code_ecue || null,
      volume_horaire_cm,
      taux_horaire_cm,
      volume_horaire_td,
      taux_horaire_td,
      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Matière non trouvée'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Matière mise à jour avec succès',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour de la matière:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};
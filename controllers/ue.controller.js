const db = require('../config/db.config');

exports.createUE = async (req, res) => {
  try {
    const { libelle, semestre_id, categorie_id, maquette_id, code_UE } = req.body;
    
    // Validation des données
    if (!libelle || !semestre_id || !categorie_id || !maquette_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Tous les champs sont requis' 
      });
    }
    
    // Validation du code_UE (optionnel mais recommandé)
    if (code_UE) {
      // Vérifier si le code existe déjà
      const checkQuery = 'SELECT id FROM ue WHERE code_UE = $1';
      const checkResult = await db.query(checkQuery, [code_UE]);
      
      if (checkResult.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Ce code UE existe déjà'
        });
      }
    }
    
    const query = `
      INSERT INTO ue (libelle, semestre_id, categorie_id, maquette_id, code_UE)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    
    const values = [libelle, semestre_id, categorie_id, maquette_id, code_UE || null];
    const result = await db.query(query, values);
    
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




//==============================

// ue.controller.js

exports.updateUE = async (req, res) => {
  try {
    const { id } = req.params;
    const { libelle, code_ue } = req.body;

    if (!libelle) {
      return res.status(400).json({
        success: false,
        message: 'Le libellé est requis'
      });
    }

    // Vérifier si le code_ue est déjà pris par une AUTRE UE
    if (code_ue) {
      const checkQuery = 'SELECT id FROM ue WHERE code_ue = $1 AND id != $2';
      const checkResult = await db.query(checkQuery, [code_ue, id]);

      if (checkResult.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Ce code UE est déjà utilisé par une autre UE'
        });
      }
    }

    const query = `
      UPDATE ue
      SET libelle = $1,
          code_ue = $2
      WHERE id = $3
      RETURNING *
    `;

    const result = await db.query(query, [libelle, code_ue || null, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'UE non trouvée'
      });
    }

    res.status(200).json({
      success: true,
      message: 'UE mise à jour avec succès',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('Erreur lors de la mise à jour de l\'UE:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};
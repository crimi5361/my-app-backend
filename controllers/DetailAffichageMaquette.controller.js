// controllers/maquetteDetailController.js
const db = require('../config/db.config');

exports.getMaquetteDetailStructured = async (req, res) => {
  try {
    const { id } = req.params;
    
    // 1. Récupérer les informations de base de la maquette
    const maquetteQuery = `
      SELECT 
        m.id,
        m.parcour,
        f.nom as filiere_nom,
        f.sigle as filiere_sigle,
        n.libelle as niveau_libelle,
        a.annee as annee_academique
      FROM maquette m
      LEFT JOIN filiere f ON m.filiere_id = f.id
      LEFT JOIN niveau n ON m.niveau_id = n.id
      LEFT JOIN anneeacademique a ON m.anneeacademique_id = a.id
      WHERE m.id = $1
    `;
    
    const maquetteResult = await db.query(maquetteQuery, [id]);
    
    if (maquetteResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Maquette non trouvée' 
      });
    }
    
    const maquette = maquetteResult.rows[0];
    
    // 2. Récupérer tous les semestres
    const semestresQuery = `
      SELECT id, nom as libelle 
      FROM semestre 
      ORDER BY nom
    `;
    
    const semestresResult = await db.query(semestresQuery);
    const semestres = semestresResult.rows;
    
    const structuredData = {
      maquette: maquette,
      semestres: []
    };
    
    for (const semestre of semestres) {
      // ✅ CORRECTION : ajout de ue.code_ue dans le SELECT
      const uesQuery = `
        SELECT 
          ue.id,
          ue.libelle,
          ue.code_ue,
          ue.categorie_id,
          c.nom as categorie_nom
        FROM ue
        LEFT JOIN categorie c ON ue.categorie_id = c.id
        WHERE ue.maquette_id = $1 AND ue.semestre_id = $2
        ORDER BY ue.libelle
      `;
      
      const uesResult = await db.query(uesQuery, [id, semestre.id]);
      const ues = uesResult.rows;
      
      const uesWithMatieres = [];
      
      for (const ue of ues) {
        // ✅ CORRECTION : ajout de m.code_ecue dans le SELECT
        const matieresQuery = `
          SELECT 
            m.id,
            m.nom,
            m.coefficient,
            m.code_ecue,
            m.ue_id,
            m.volume_horaire_cm,
            m.taux_horaire_cm,
            m.volume_horaire_td,
            m.taux_horaire_td
          FROM matiere m
          WHERE m.ue_id = $1
          ORDER BY m.nom
        `;
        
        const matieresResult = await db.query(matieresQuery, [ue.id]);
        const matieres = matieresResult.rows;
        
        const creditTotal = matieres.reduce((total, matiere) => {
          return total + (parseFloat(matiere.coefficient) || 0);
        }, 0);
        
        uesWithMatieres.push({
          ...ue,
          matieres: matieres,
          credit_total: creditTotal
        });
      }
      
      // Ne pousser que les semestres ayant des UE (optionnel, retire si tu veux tous les semestres)
      structuredData.semestres.push({
        id: semestre.id,
        libelle: semestre.libelle,
        ues: uesWithMatieres
      });
    }
    
    res.json(structuredData);
    
  } catch (error) {
    console.error('Erreur lors de la récupération des détails de la maquette:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur serveur lors de la récupération des détails de la maquette' 
    });
  }
};
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
    
    // 2. Récupérer tous les semestres (même ceux sans UE)
    const semestresQuery = `
      SELECT id, nom as libelle 
      FROM semestre 
      ORDER BY nom
    `;
    
    const semestresResult = await db.query(semestresQuery);
    const semestres = semestresResult.rows;
    
    // 3. Pour chaque semestre, récupérer les UE et leurs matières
    const structuredData = {
      maquette: maquette,
      semestres: []
    };
    
    for (const semestre of semestres) {
      // Récupérer les UE de ce semestre pour cette maquette
      const uesQuery = `
        SELECT 
          ue.id,
          ue.libelle,
          ue.categorie_id,
          c.nom as categorie_nom
        FROM ue
        LEFT JOIN categorie c ON ue.categorie_id = c.id
        WHERE ue.maquette_id = $1 AND ue.semestre_id = $2
        ORDER BY ue.libelle
      `;
      
      const uesResult = await db.query(uesQuery, [id, semestre.id]);
      const ues = uesResult.rows;
      
      // Pour chaque UE, récupérer ses matières
      const uesWithMatieres = [];
      
      for (const ue of ues) {
        const matieresQuery = `
          SELECT 
            m.id,
            m.nom,
            m.coefficient,
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
        
        // Calculer le crédit total de l'UE (somme des coefficients)
        const creditTotal = matieres.reduce((total, matiere) => {
          return total + (matiere.coefficient || 0);
        }, 0);
        
        uesWithMatieres.push({
          ...ue,
          matieres: matieres,
          credit_total: creditTotal // Ajout du crédit total de l'UE
        });
      }
      
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
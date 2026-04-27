const db = require('../config/db.config');

// Créer une nouvelle maquette
exports.createMaquette = async (req, res) => {
  try {
    const { filiere_id, niveau_id, anneeacademique_id, parcour } = req.body;
    
    console.log('Données reçues:', req.body); // Debug

    // Validation des données requises
    if (!filiere_id || !niveau_id || !anneeacademique_id || !parcour) {
      return res.status(400).json({
        success: false,
        message: 'Tous les champs sont obligatoires'
      });
    }

    // Vérification de l'existence de la filière
    const filiereCheck = await db.query('SELECT id FROM filiere WHERE id = $1', [filiere_id]);
    if (filiereCheck.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Filière non trouvée'
      });
    }

    // Vérification de l'existence du niveau
    const niveauCheck = await db.query('SELECT id FROM niveau WHERE id = $1', [niveau_id]);
    if (niveauCheck.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Niveau non trouvé'
      });
    }

    // Vérification de l'existence de l'année académique
    const anneeCheck = await db.query('SELECT id FROM anneeacademique WHERE id = $1', [anneeacademique_id]);
    if (anneeCheck.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Année académique non trouvée'
      });
    }

    // Vérification si la maquette existe déjà
    const existingMaquette = await db.query(
      'SELECT id FROM maquette WHERE filiere_id = $1 AND niveau_id = $2 AND anneeacademique_id = $3 AND parcour = $4',
      [filiere_id, niveau_id, anneeacademique_id, parcour]
    );

    if (existingMaquette.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Une maquette existe déjà pour cette combinaison filière/niveau/année/parcour'
      });
    }

    const query = `
      INSERT INTO maquette (filiere_id, niveau_id, anneeacademique_id, parcour, date_creation)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `;
    
    const values = [filiere_id, niveau_id, anneeacademique_id, parcour];
    const result = await db.query(query, values);
    
    res.status(201).json({
      success: true,
      message: 'Maquette créée avec succès',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Erreur détaillée:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la maquette',
      error: error.message
    });
  }
};



// Récupérer toutes les maquettes avec filtre par année académique
exports.getAllMaquettes = async (req, res) => {
  try {
    const { annee_id } = req.query;
    
    let query = `
      SELECT 
        m.*, 
        f.nom as filiere_nom, 
        f.sigle as filiere_sigle, 
        n.libelle as niveau_libelle, 
        a.annee as annee_academique,
        a.id as annee_id
      FROM maquette m
      LEFT JOIN filiere f ON m.filiere_id = f.id
      LEFT JOIN niveau n ON m.niveau_id = n.id
      LEFT JOIN anneeacademique a ON m.anneeacademique_id = a.id
    `;
    
    let values = [];
    
    // Filtrer par année académique si spécifié
    if (annee_id) {
      query += ` WHERE a.id = $1`;
      values.push(annee_id);
    }
    
    query += ` ORDER BY m.date_creation DESC`;
    
    const result = await db.query(query, values);
    
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching maquettes:', error);
    res.status(500).json({ 
      message: 'Error fetching maquettes',
      error: error.message 
    });
  }
};

// Récupérer l'année académique en cours
exports.getAllAnnee = async (req, res) => {
  try {
    const query = `
      SELECT id, annee, etat
      FROM anneeacademique;
    `;
    
    const result = await db.query(query);
    
    if (result.rows.length > 0) {
      res.status(200).json(result.rows);  // ✅ renvoie toutes les lignes
    } else {
      res.status(404).json({ 
        message: 'Aucune année académique trouvée' 
      });
    }
  } catch (error) {
    console.error('Error fetching years:', error);
    res.status(500).json({ 
      message: 'Error fetching academic years',
      error: error.message 
    });
  }
};


//============================================================================================================================//



// Détails d'une maquette
exports.getMaquetteDetail = async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      SELECT 
        m.id,
        f.nom as filiere_nom,
        f.sigle as filiere_sigle,
        n.libelle as niveau_libelle,
        m.anneeacademique_id,
        m.parcour
      FROM maquette m
      JOIN filiere f ON m.filiere_id = f.id
      JOIN niveau n ON m.niveau_id = n.id
      WHERE m.id = $1
    `;
    
    const result = await db.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Maquette non trouvée' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erreur lors de la récupération de la maquette:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};

// UE d'une maquette
// controllers/maquette.controller.js


exports.getMaquetteUes = async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      SELECT 
        u.id,
        u.libelle,
        u.semestre_id,
        s.nom as semestre_libelle,
        u.categorie_id,
        c.nom as categorie_nom
      FROM ue u
      JOIN semestre s ON u.semestre_id = s.id
      JOIN categorie c ON u.categorie_id = c.id
      WHERE u.maquette_id = $1
      ORDER BY s.nom, u.libelle
    `;
    
    const result = await db.query(query, [id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des UE:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};

// Matières d'une maquette
exports.getMaquetteMatieres = async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      SELECT 
        m.id,
        m.nom,
        m.coefficient,
        m.ue_id,
        u.libelle as ue_libelle,
        m.volume_horaire_cm,
        m.taux_horaire_cm,
        m.volume_horaire_td,
        m.taux_horaire_td
      FROM matiere m
      JOIN ue u ON m.ue_id = u.id
      WHERE u.maquette_id = $1
      ORDER BY u.libelle, m.nom
    `;
    
    const result = await db.query(query, [id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Erreur lors de la récupération des matières:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};
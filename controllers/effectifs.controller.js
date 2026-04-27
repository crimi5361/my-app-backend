const db = require('../config/db.config');

exports.getEffectifsParFiliereNiveau = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { annee_id } = req.query;
    // Récupérer l'ID du département de l'utilisateur connecté
    const departement_id = req.user?.departement_id || req.headers.departement_id || localStorage.getItem("departement_id");

    if (!departement_id) {
      return res.status(400).json({
        success: false,
        message: 'Département non spécifié'
      });
    }

    const query = `
      SELECT 
        f.nom as filiere,
        f.sigle as filiere_sigle,
        n.libelle as niveau,
        c.type_parcours as cycle,
        COUNT(e.id) as nombre_inscrits
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN curcus c ON e.curcus_id = c.id
      JOIN anneeacademique aa ON e.annee_academique_id = aa.id
      WHERE aa.id = $1
      AND e.departement_id = $2  -- FILTRE PAR DÉPARTEMENT
      GROUP BY f.nom, f.sigle, n.libelle, c.type_parcours
      ORDER BY f.nom, n.libelle
    `;

    const result = await client.query(query, [annee_id || 1, departement_id]);

    // Total étudiants pour ce département
    const totalQuery = `
      SELECT COUNT(*) as total_inscrits
      FROM etudiant e
      JOIN anneeacademique aa ON e.annee_academique_id = aa.id
      WHERE aa.id = $1
      AND e.departement_id = $2  -- FILTRE PAR DÉPARTEMENT
    `;
    
    const totalResult = await client.query(totalQuery, [annee_id || 1, departement_id]);

    res.status(200).json({
      success: true,
      data: {
        effectifs: result.rows,
        total_inscrits: parseInt(totalResult.rows[0].total_inscrits)
      }
    });

  } catch (error) {
    console.error('Erreur récupération effectifs:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des effectifs'
    });
  } finally {
    client.release();
  }
};

exports.getAnneesAcademiques = async (req, res) => {
  const client = await db.connect();
  
  try {
    const query = `
      SELECT id, annee, etat
      FROM anneeacademique
      ORDER BY annee DESC
    `;

    const result = await client.query(query);

    res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Erreur récupération années:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des années académiques'
    });
  } finally {
    client.release();
  }
};
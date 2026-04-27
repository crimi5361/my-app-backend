const db = require('../config/db.config');

// Route pour la page Classes (liste simple)
exports.getListeClasses = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { annee_id } = req.query;
    // Récupérer depuis le token ou les infos de l'utilisateur connecté
    const departement_id = req.user?.departement_id; // Si vous avez middleware d'authentification

    const query = `
      SELECT DISTINCT
  c.id,
  c.nom,
  c.description,
  aa.annee as annee_academique,
  aa.etat as annee_etat,
  COUNT(DISTINCT g.id) as nombre_groupes,
  COUNT(DISTINCT e.id) as effectif_total,
  -- Récupérer explicitement la filière et le niveau depuis les tables étudiant
  (SELECT f2.nom FROM filiere f2 
   JOIN etudiant e2 ON e2.id_filiere = f2.id 
   WHERE e2.groupe_id IN (SELECT g2.id FROM groupe g2 WHERE g2.classe_id = c.id) 
   LIMIT 1) as filiere,
  (SELECT n2.libelle FROM niveau n2 
   JOIN etudiant e2 ON e2.niveau_id = n2.id 
   WHERE e2.groupe_id IN (SELECT g2.id FROM groupe g2 WHERE g2.classe_id = c.id) 
   LIMIT 1) as niveau,
  d.nom as departement
FROM classe c
LEFT JOIN groupe g ON g.classe_id = c.id
LEFT JOIN etudiant e ON e.groupe_id = g.id
LEFT JOIN anneeacademique aa ON e.annee_academique_id = aa.id
LEFT JOIN departement d ON e.departement_id = d.id
WHERE ($1::int IS NULL OR aa.id = $1)
AND e.departement_id = $2
GROUP BY c.id, c.nom, c.description, aa.annee, aa.etat, d.nom
ORDER BY c.nom
    `;

    const result = await client.query(query, [annee_id || null, departement_id]);

    res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Erreur récupération classes:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des classes'
    });
  } finally {
    client.release();
  }
};


// Route pour DetailClasse (détails d'une classe spécifique)
exports.getDetailClasse = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { id } = req.params;
    
    const query = `
       SELECT 
        c.id,
        c.nom,
        c.description,
        aa.annee as annee_academique,
        aa.etat as annee_etat,
        -- Récupération précise de la filière et du niveau
        (SELECT f2.nom FROM filiere f2 
         JOIN etudiant e2 ON e2.id_filiere = f2.id 
         JOIN groupe g2 ON e2.groupe_id = g2.id 
         WHERE g2.classe_id = c.id LIMIT 1) as filiere,
        (SELECT n2.libelle FROM niveau n2 
         JOIN etudiant e2 ON e2.niveau_id = n2.id 
         JOIN groupe g2 ON e2.groupe_id = g2.id 
         WHERE g2.classe_id = c.id LIMIT 1) as niveau,
        COUNT(DISTINCT e.id) as effectif_total,
        g.id as groupe_id,
        g.nom as groupe_nom,
        g.capacite_max as groupe_capacite,
        COUNT(e_g.id) as effectif_groupe
      FROM classe c
      LEFT JOIN groupe g ON g.classe_id = c.id
      LEFT JOIN etudiant e ON e.groupe_id = g.id
      LEFT JOIN etudiant e_g ON e_g.groupe_id = g.id
      LEFT JOIN anneeacademique aa ON e.annee_academique_id = aa.id
      WHERE c.id = $1
      GROUP BY c.id, c.nom, c.description, aa.annee, aa.etat, g.id, g.nom, g.capacite_max
      ORDER BY g.nom
    `;

    const result = await client.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Classe non trouvée'
      });
    }

    // Structurer la réponse
    const classe = {
      id: result.rows[0].id,
      nom: result.rows[0].nom,
      description: result.rows[0].description,
      annee_academique: result.rows[0].annee_academique,
      annee_etat: result.rows[0].annee_etat,
      filiere: result.rows[0].filiere,
      niveau: result.rows[0].niveau,
      effectif_total: result.rows[0].effectif_total,
      groupes: result.rows
        .filter(row => row.groupe_id !== null)
        .map(row => ({
          id: row.groupe_id,
          nom: row.groupe_nom,
          capacite_max: row.groupe_capacite,
          effectif: row.effectif_groupe,
          taux_remplissage: row.groupe_capacite > 0 
            ? Math.round((row.effectif_groupe / row.groupe_capacite) * 100) 
            : 0
        }))
    };

    res.status(200).json({
      success: true,
      data: classe
    });

  } catch (error) {
    console.error('Erreur récupération détail classe:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des détails de la classe'
    });
  } finally {
    client.release();
  }
};
// Route pour recuperer uniquement les information sur le groupe a partir de l'id ,

exports.getGroupeSimpleInfo = async (req, res) => {
  const client = await db.connect();

  try {
    const { id } = req.params;

    const query = `
      SELECT 
        g.id,
        g.nom
      FROM groupe g
      WHERE g.id = $1
    `;
    
    const result = await client.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Groupe non trouvé' });
    }
    
    res.status(200).json(result.rows[0]);
    
  } catch (error) {
    console.error('Erreur:', error);
    res.status(500).json({ message: 'Erreur serveur', error: error.message });
  } finally {
    client.release(); // Important : libérer la connexion
  }
};


// Route pour DetailGroupe (détails d'un groupe spécifique)
exports.getDetailGroupe = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { id } = req.params;
    
    // D'abord récupérer les infos du groupe
    const groupeQuery = `
      SELECT 
        g.id,
        g.nom,
        g.capacite_max,
        c.nom as classe_nom,
        COUNT(e.id) as effectif,
        CASE 
          WHEN g.capacite_max > 0 
          THEN ROUND((COUNT(e.id) * 100.0 / g.capacite_max), 2)
          ELSE 0 
        END as taux_remplissage
      FROM groupe g
      LEFT JOIN classe c ON g.classe_id = c.id
      LEFT JOIN etudiant e ON e.groupe_id = g.id
      WHERE g.id = $1
      GROUP BY g.id, g.nom, g.capacite_max, c.nom
    `;

    const groupeResult = await client.query(groupeQuery, [id]);

    if (groupeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Groupe non trouvé'
      });
    }

    const groupe = groupeResult.rows[0];

    // Ensuite récupérer les étudiants du groupe
    const etudiantsQuery = `
      SELECT 
          e.id,
          e.matricule_iipea,
          e.nom,
          e.prenoms,
          e.telephone,
          e.email,
          e.photo_url,
          f.nom as filiere,
          n.libelle as niveau,
          c.type_parcours as cursus, 
          e.statut_scolaire
      FROM etudiant e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN curcus c ON e.curcus_id = c.id  
      WHERE e.groupe_id = $1
      ORDER BY e.nom, e.prenoms
    `;

    const etudiantsResult = await client.query(etudiantsQuery, [id]);

    const response = {
      id: groupe.id,
      nom: groupe.nom,
      capacite_max: groupe.capacite_max,
      effectif: parseInt(groupe.effectif),
      taux_remplissage: parseFloat(groupe.taux_remplissage),
      classe_nom: groupe.classe_nom,
      etudiants: etudiantsResult.rows
    };

    res.status(200).json({
      success: true,
      data: response
    });

  } catch (error) {
    console.error('Erreur récupération détail groupe:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des détails du groupe'
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


exports.getClassesAvecGroupes = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { annee_id } = req.query;
    
    const query = `
      SELECT 
        c.id as classe_id,
        c.nom as classe_nom,
        c.description as classe_description,
        g.id as groupe_id,
        g.nom as groupe_nom,
        g.capacite_max as groupe_capacite,
        COUNT(e.id) as effectif_groupe,
        aa.annee as annee_academique,
        aa.etat as annee_etat,
        (SELECT COUNT(e2.id) 
         FROM etudiant e2 
         JOIN groupe g2 ON e2.groupe_id = g2.id 
         WHERE g2.classe_id = c.id) as effectif_total_classe
      FROM classe c
      LEFT JOIN groupe g ON g.classe_id = c.id
      LEFT JOIN etudiant e ON e.groupe_id = g.id
      LEFT JOIN anneeacademique aa ON e.annee_academique_id = aa.id
      WHERE ($1::int IS NULL OR aa.id = $1)
      GROUP BY c.id, c.nom, c.description, g.id, g.nom, g.capacite_max, aa.annee, aa.etat
      ORDER BY c.nom, g.nom
    `;

    const result = await client.query(query, [annee_id || null]);

    const classesMap = new Map();
    
    result.rows.forEach(row => {
      if (!classesMap.has(row.classe_id)) {
        classesMap.set(row.classe_id, {
          id: row.classe_id,
          nom: row.classe_nom,
          description: row.classe_description,
          annee_academique: row.annee_academique,
          annee_etat: row.annee_etat,
          effectif_total: row.effectif_total_classe,
          groupes: []
        });
      }
      
      const classe = classesMap.get(row.classe_id);
      
      if (row.groupe_id) {
        classe.groupes.push({
          id: row.groupe_id,
          nom: row.groupe_nom,
          capacite_max: row.groupe_capacite,
          effectif: row.effectif_groupe,
          taux_remplissage: row.groupe_capacite > 0 
            ? Math.round((row.effectif_groupe / row.groupe_capacite) * 100) 
            : 0
        });
      }
    });

    const classes = Array.from(classesMap.values());

    res.status(200).json({
      success: true,
      data: classes
    });

  } catch (error) {
    console.error('Erreur récupération classes:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des classes'
    });
  } finally {
    client.release();
  }
};
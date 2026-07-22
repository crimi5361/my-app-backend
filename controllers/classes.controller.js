const db = require('../config/db.config');

// Route pour la page Classes (liste simple)
exports.getListeClasses = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { annee_id } = req.query;
    // Récupérer depuis le token ou les infos de l'utilisateur connecté
    const departement_id = req.user?.departement_id; // Si vous avez middleware d'authentification

    const query = `
      SELECT
  c.id,
  c.nom,
  c.description,
  aa.annee as annee_academique,
  aas.etat as annee_etat,
  f.nom as filiere,
  n.libelle as niveau,
  (SELECT nom FROM site WHERE id = $2) as departement,
  COUNT(DISTINCT g.id) as nombre_groupes,
  COUNT(DISTINCT roster.etudiant_id) as effectif_total
FROM classe c
LEFT JOIN filiere f ON f.id = c.filiere_id
LEFT JOIN niveau n ON n.id = c.niveau_id
LEFT JOIN anneeacademique aa ON aa.id = c.annee_academique_id
LEFT JOIN anneeacademique_site aas ON aas.anneeacademique_id = aa.id AND aas.site_id = $2
LEFT JOIN groupe g ON g.classe_id = c.id
LEFT JOIN LATERAL (
  -- Un étudiant appartient à ce groupe soit "en direct" (etudiant.groupe_id, année en cours),
  -- soit via la trace figée d'historique_inscription (année clôturée / quittée depuis) — jamais
  -- uniquement via l'un ou l'autre, sous peine de perdre les effectifs des années passées.
  SELECT e2.id AS etudiant_id FROM etudiant e2 WHERE e2.groupe_id = g.id
  UNION
  SELECT h2.etudiant_id FROM historique_inscription h2 WHERE h2.groupe_id = g.id
) roster ON true
WHERE ($1::int IS NULL OR c.annee_academique_id = $1)
AND EXISTS (
  SELECT 1 FROM etudiant e3 WHERE e3.id = roster.etudiant_id AND e3.site_id = $2
)
GROUP BY c.id, c.nom, c.description, aa.annee, aas.etat, f.nom, n.libelle
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
        (SELECT etat FROM anneeacademique_site WHERE anneeacademique_id = aa.id ORDER BY (etat = 'en cour') DESC LIMIT 1) as annee_etat,
        f.nom as filiere,
        n.libelle as niveau,
        (SELECT COUNT(DISTINCT roster_c.etudiant_id) FROM groupe g4
           LEFT JOIN LATERAL (
             SELECT e4.id AS etudiant_id FROM etudiant e4 WHERE e4.groupe_id = g4.id
             UNION
             SELECT h4.etudiant_id FROM historique_inscription h4 WHERE h4.groupe_id = g4.id
           ) roster_c ON true
         WHERE g4.classe_id = c.id) as effectif_total,
        g.id as groupe_id,
        g.nom as groupe_nom,
        g.capacite_max as groupe_capacite,
        COUNT(DISTINCT roster.etudiant_id) as effectif_groupe
      FROM classe c
      LEFT JOIN filiere f ON f.id = c.filiere_id
      LEFT JOIN niveau n ON n.id = c.niveau_id
      LEFT JOIN anneeacademique aa ON aa.id = c.annee_academique_id
      LEFT JOIN groupe g ON g.classe_id = c.id
      LEFT JOIN LATERAL (
        SELECT e2.id AS etudiant_id FROM etudiant e2 WHERE e2.groupe_id = g.id
        UNION
        SELECT h2.etudiant_id FROM historique_inscription h2 WHERE h2.groupe_id = g.id
      ) roster ON true
      WHERE c.id = $1
      GROUP BY c.id, c.nom, c.description, aa.id, aa.annee, f.nom, n.libelle, g.id, g.nom, g.capacite_max
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
        g.nom,
        c.description AS classe_description
      FROM groupe g
      LEFT JOIN classe c ON g.classe_id = c.id
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
    client.release();
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
        COUNT(DISTINCT roster.etudiant_id) as effectif,
        CASE
          WHEN g.capacite_max > 0
          THEN ROUND((COUNT(DISTINCT roster.etudiant_id) * 100.0 / g.capacite_max), 2)
          ELSE 0
        END as taux_remplissage
      FROM groupe g
      LEFT JOIN classe c ON g.classe_id = c.id
      LEFT JOIN LATERAL (
        SELECT e.id AS etudiant_id FROM etudiant e WHERE e.groupe_id = g.id
        UNION
        SELECT h.etudiant_id FROM historique_inscription h WHERE h.groupe_id = g.id
      ) roster ON true
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

    // Ensuite récupérer les étudiants du groupe — en direct (année en cours) ou via la trace
    // figée d'historique_inscription (étudiant réinscrit depuis vers une année suivante, mais
    // qui doit rester listé dans le groupe de l'année à laquelle ce groupe appartient).
    const etudiantsQuery = `
      SELECT
          e.id,
          e.matricule_iipea,
          e.nom,
          e.prenoms,
          e.telephone,
          e.email,
          e.photo_url,
          COALESCE(f_h.nom, f.nom) as filiere,
          COALESCE(n_h.libelle, n.libelle) as niveau,
          c.type_parcours as cursus,
          COALESCE(h.statut_scolaire, e.statut_scolaire) as statut_scolaire
      FROM (
        SELECT e2.id AS etudiant_id FROM etudiant e2 WHERE e2.groupe_id = $1
        UNION
        SELECT h2.etudiant_id FROM historique_inscription h2 WHERE h2.groupe_id = $1
      ) roster
      JOIN etudiant e ON e.id = roster.etudiant_id
      LEFT JOIN historique_inscription h ON h.etudiant_id = e.id AND h.groupe_id = $1
      LEFT JOIN filiere f_h ON f_h.id = h.id_filiere
      LEFT JOIN niveau n_h ON n_h.id = h.niveau_id
      LEFT JOIN filiere f ON f.id = e.id_filiere
      LEFT JOIN niveau n ON n.id = e.niveau_id
      LEFT JOIN curcus c ON c.id = e.curcus_id
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
    const departement_id = req.user?.departement_id;
    const query = `
      SELECT a.id, a.annee, s.etat
      FROM anneeacademique a
      LEFT JOIN anneeacademique_site s ON s.anneeacademique_id = a.id AND s.site_id = $1
      ORDER BY a.annee DESC
    `;

    const result = await client.query(query, [departement_id]);

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
        COUNT(DISTINCT roster.etudiant_id) as effectif_groupe,
        aa.annee as annee_academique,
        (SELECT etat FROM anneeacademique_site WHERE anneeacademique_id = aa.id ORDER BY (etat = 'en cour') DESC LIMIT 1) as annee_etat,
        (SELECT COUNT(DISTINCT roster2.etudiant_id) FROM groupe g2
           LEFT JOIN LATERAL (
             SELECT e2.id AS etudiant_id FROM etudiant e2 WHERE e2.groupe_id = g2.id
             UNION
             SELECT h2.etudiant_id FROM historique_inscription h2 WHERE h2.groupe_id = g2.id
           ) roster2 ON true
         WHERE g2.classe_id = c.id) as effectif_total_classe
      FROM classe c
      LEFT JOIN groupe g ON g.classe_id = c.id
      LEFT JOIN LATERAL (
        SELECT e3.id AS etudiant_id FROM etudiant e3 WHERE e3.groupe_id = g.id
        UNION
        SELECT h3.etudiant_id FROM historique_inscription h3 WHERE h3.groupe_id = g.id
      ) roster ON true
      LEFT JOIN anneeacademique aa ON aa.id = c.annee_academique_id
      WHERE ($1::int IS NULL OR aa.id = $1)
      GROUP BY c.id, c.nom, c.description, g.id, g.nom, g.capacite_max, aa.id, aa.annee
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
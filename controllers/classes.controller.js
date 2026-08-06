const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

// Route pour la page Classes (liste simple)
exports.getListeClasses = async (req, res) => {
  const client = await db.connect();

  try {
    const { annee_id } = req.query;
    // Récupérer depuis le token ou les infos de l'utilisateur connecté
    const departement_id = req.user?.departement_id; // Si vous avez middleware d'authentification
    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site ($2) existant. c.filiere_id
    // est une propriété directe de la classe, donc appliqué une seule fois au niveau global plutôt
    // que dans chacune des 3 branches EXISTS (elles décrivent des sources d'étudiants, pas d'écoles).
    const ecoleId = getEcoleScopeFromUser(req);

    // Chantier 6 (2026-08-01) : un étudiant n'a plus forcément de groupe tant que sa classe n'a
    // pas été découpée manuellement — l'effectif et la visibilité de la classe ne doivent donc
    // plus dépendre de l'existence d'un groupe. Trois sources combinées :
    //  (1) déjà groupés — logique historique strictement INCHANGÉE (via etudiant.groupe_id) ;
    //  (2) historique — logique historique strictement INCHANGÉE (via historique_inscription) ;
    //  (3) NOUVEAU, additif uniquement : étudiants SANS groupe (`groupe_id IS NULL`) dont
    //      filiere/niveau/annee_academique/curcus correspondent à la classe. Cette 3ᵉ branche ne
    //      peut jamais rien retirer ni dupliquer ce que trouvent (1)/(2) : elle est explicitement
    //      exclusive aux étudiants sans groupe, donc n'existe pour aucune donnée antérieure à ce
    //      chantier (où tous les étudiants avaient déjà un groupe). Ne PAS fusionner (1) et (3) en
    //      un seul filtre sur les seuls critères filiere/niveau/annee/curcus : des classes
    //      anciennes ont un curcus_id incohérent avec celui de leurs étudiants réels (constaté en
    //      base), ce qui ferait disparaître à tort des étudiants déjà correctement groupés.
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
  (SELECT COUNT(DISTINCT combined.etudiant_id) FROM (
     SELECT e5.id AS etudiant_id FROM etudiant e5
      JOIN groupe g5a ON g5a.id = e5.groupe_id
      WHERE g5a.classe_id = c.id
     UNION
     SELECT h5.etudiant_id FROM historique_inscription h5
      JOIN groupe g5 ON g5.id = h5.groupe_id
      WHERE g5.classe_id = c.id
     UNION
     SELECT e5b.id FROM etudiant e5b
      WHERE e5b.groupe_id IS NULL
        AND e5b.id_filiere = c.filiere_id AND e5b.niveau_id = c.niveau_id
        AND e5b.annee_academique_id = c.annee_academique_id
        AND e5b.curcus_id IS NOT DISTINCT FROM c.curcus_id
   ) combined) as effectif_total
FROM classe c
LEFT JOIN filiere f ON f.id = c.filiere_id
LEFT JOIN niveau n ON n.id = c.niveau_id
LEFT JOIN anneeacademique aa ON aa.id = c.annee_academique_id
LEFT JOIN anneeacademique_site aas ON aas.anneeacademique_id = aa.id AND aas.site_id = $2
-- Chantier 11 (2026-08-03) — sous-phase 3.5 : le Groupe primaire (technique, interne au moteur
-- d'inscription et à Gestion des groupes) ne doit jamais compter comme un "groupe" pédagogique
-- visible ici — voir services/classeGroupe.service.js pour ce que ce groupe représente.
LEFT JOIN groupe g ON g.classe_id = c.id AND g.est_primaire = false
WHERE ($1::int IS NULL OR c.annee_academique_id = $1)
AND (
  EXISTS (
    SELECT 1 FROM etudiant e3
    JOIN groupe g3a ON g3a.id = e3.groupe_id
    WHERE g3a.classe_id = c.id AND e3.site_id = $2
  )
  OR EXISTS (
    SELECT 1 FROM historique_inscription h3
    JOIN groupe g3 ON g3.id = h3.groupe_id
    JOIN etudiant e3b ON e3b.id = h3.etudiant_id
    WHERE g3.classe_id = c.id AND e3b.site_id = $2
  )
  OR EXISTS (
    SELECT 1 FROM etudiant e3c
    WHERE e3c.groupe_id IS NULL
      AND e3c.id_filiere = c.filiere_id AND e3c.niveau_id = c.niveau_id
      AND e3c.annee_academique_id = c.annee_academique_id
      AND e3c.curcus_id IS NOT DISTINCT FROM c.curcus_id AND e3c.site_id = $2
  )
)
AND ($3::int IS NULL OR f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))
GROUP BY c.id, c.nom, c.description, aa.annee, aas.etat, f.nom, n.libelle
ORDER BY c.nom
    `;

    const result = await client.query(query, [annee_id || null, departement_id, ecoleId]);

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
        c.annee_academique_id,
        c.filiere_id,
        c.niveau_id,
        aa.annee as annee_academique,
        (SELECT etat FROM anneeacademique_site WHERE anneeacademique_id = aa.id ORDER BY (etat = 'en cour') DESC LIMIT 1) as annee_etat,
        f.nom as filiere,
        n.libelle as niveau,
        -- Chantier 6 : mêmes 3 sources que getListeClasses — groupés (inchangé) + historique
        -- (inchangé) + sans groupe correspondant aux critères (nouveau, additif uniquement).
        (SELECT COUNT(DISTINCT combined.etudiant_id) FROM (
           SELECT e4.id AS etudiant_id FROM etudiant e4
            JOIN groupe g4a ON g4a.id = e4.groupe_id
            WHERE g4a.classe_id = c.id
           UNION
           SELECT h4.etudiant_id FROM historique_inscription h4
            JOIN groupe g4 ON g4.id = h4.groupe_id
            WHERE g4.classe_id = c.id
           UNION
           SELECT e4b.id FROM etudiant e4b
            WHERE e4b.groupe_id IS NULL
              AND e4b.id_filiere = c.filiere_id AND e4b.niveau_id = c.niveau_id
              AND e4b.annee_academique_id = c.annee_academique_id
              AND e4b.curcus_id IS NOT DISTINCT FROM c.curcus_id
         ) combined) as effectif_total,
        g.id as groupe_id,
        g.nom as groupe_nom,
        g.capacite_max as groupe_capacite,
        COUNT(DISTINCT roster.etudiant_id) as effectif_groupe
      FROM classe c
      LEFT JOIN filiere f ON f.id = c.filiere_id
      LEFT JOIN niveau n ON n.id = c.niveau_id
      LEFT JOIN anneeacademique aa ON aa.id = c.annee_academique_id
      -- Chantier 11 (2026-08-03) — sous-phase 3.5 : Groupe primaire jamais listé ici (voir même
      -- remarque dans getListeClasses). effectif_total reste correct : il compte les étudiants du
      -- primaire (ci-dessus, hors de ce JOIN), ils sont bien inscrits, juste pas encore répartis.
      LEFT JOIN groupe g ON g.classe_id = c.id AND g.est_primaire = false
      LEFT JOIN LATERAL (
        SELECT e2.id AS etudiant_id FROM etudiant e2 WHERE e2.groupe_id = g.id
        UNION
        SELECT h2.etudiant_id FROM historique_inscription h2 WHERE h2.groupe_id = g.id
      ) roster ON true
      WHERE c.id = $1
      GROUP BY c.id, c.nom, c.description, c.annee_academique_id, c.filiere_id, c.niveau_id, aa.id, aa.annee, f.nom, n.libelle, g.id, g.nom, g.capacite_max
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
      annee_academique_id: result.rows[0].annee_academique_id,
      filiere_id: result.rows[0].filiere_id,
      niveau_id: result.rows[0].niveau_id,
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
        c.description AS classe_description,
        c.filiere_id,
        c.niveau_id,
        c.annee_academique_id
      FROM groupe g
      LEFT JOIN classe c ON g.classe_id = c.id
      WHERE g.id = $1 AND g.est_primaire = false
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
      WHERE g.id = $1 AND g.est_primaire = false
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
        -- Chantier 6 : mêmes 3 sources que getListeClasses/getDetailClasse.
        (SELECT COUNT(DISTINCT combined.etudiant_id) FROM (
           SELECT e2.id AS etudiant_id FROM etudiant e2
            JOIN groupe g2a ON g2a.id = e2.groupe_id
            WHERE g2a.classe_id = c.id
           UNION
           SELECT h2.etudiant_id FROM historique_inscription h2
            JOIN groupe g2 ON g2.id = h2.groupe_id
            WHERE g2.classe_id = c.id
           UNION
           SELECT e2b.id FROM etudiant e2b
            WHERE e2b.groupe_id IS NULL
              AND e2b.id_filiere = c.filiere_id AND e2b.niveau_id = c.niveau_id
              AND e2b.annee_academique_id = c.annee_academique_id
              AND e2b.curcus_id IS NOT DISTINCT FROM c.curcus_id
         ) combined) as effectif_total_classe
      FROM classe c
      -- Chantier 11 (2026-08-03) — sous-phase 3.5 : même exclusion du Groupe primaire que
      -- getListeClasses/getDetailClasse (pas de consommateur frontend actif à ce jour, corrigé
      -- par cohérence pour ne pas laisser un piège si cet endpoint est branché plus tard).
      LEFT JOIN groupe g ON g.classe_id = c.id AND g.est_primaire = false
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
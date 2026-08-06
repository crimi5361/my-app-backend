const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

// ✅ Sourcé sur vue_position_academique (pas directement `etudiant`) : etudiant.annee_academique_id
// est une position COURANTE, écrasée à chaque réinscription — un étudiant réinscrit disparaîtrait
// sinon silencieusement des effectifs de son ancienne année. La vue UNIONne la position courante
// et l'instantané figé (historique_inscription, événement 'cloture') des années déjà quittées.
exports.getEffectifsParFiliereNiveau = async (req, res) => {
  const client = await db.connect();

  try {
    const { annee_id } = req.query;
    // Récupérer l'ID du site de l'utilisateur connecté
    const departement_id = req.user?.departement_id || req.headers.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

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
      FROM vue_position_academique e
      JOIN filiere f ON e.id_filiere = f.id
      JOIN niveau n ON e.niveau_id = n.id
      JOIN curcus c ON e.curcus_id = c.id
      JOIN anneeacademique aa ON e.annee_academique_id = aa.id
      WHERE aa.id = $1
      AND e.site_id = $2  -- FILTRE PAR SITE
      AND ($3::int IS NULL OR f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))  -- Chantier 3
      GROUP BY f.nom, f.sigle, n.libelle, c.type_parcours
      ORDER BY f.nom, n.libelle
    `;

    const result = await client.query(query, [annee_id || 1, departement_id, ecoleId]);

    // Total étudiants pour ce département
    const totalQuery = `
      SELECT COUNT(*) as total_inscrits
      FROM vue_position_academique e
      JOIN anneeacademique aa ON e.annee_academique_id = aa.id
      WHERE aa.id = $1
      AND e.site_id = $2  -- FILTRE PAR SITE
      AND ($3::int IS NULL OR e.id_filiere IN (SELECT id FROM filiere WHERE departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)))  -- Chantier 3
    `;

    const totalResult = await client.query(totalQuery, [annee_id || 1, departement_id, ecoleId]);

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
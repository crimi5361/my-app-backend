const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

// ✅ Sourcé sur vue_position_academique (pas directement `etudiant`) : etudiant.annee_academique_id
// est une position COURANTE, écrasée à chaque réinscription — un étudiant réinscrit disparaîtrait
// sinon silencieusement des effectifs de son ancienne année. La vue UNIONne la position courante
// et l'instantané figé (historique_inscription, événement 'cloture') des années déjà quittées.
//
// ✅ Correctif Chantier Statistiques (2026-08-18) : `nombre_inscrits`/`total_inscrits` ne
// filtraient sur aucun standing — un étudiant en admission/réinscription encore en attente de
// paiement était compté comme un effectif au même titre qu'un étudiant réellement inscrit.
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
      AND e.standing = 'Inscrit'
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
      AND e.standing = 'Inscrit'
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

// Chantier "Filtre Groupe" — correction ciblée (2026-09-07), suite de l'audit dédié.
//
// Endpoint de LECTURE dédié, distinct de /api/decoupage/classes (divisionGroupe.controller.js,
// réservé à 'admin' pour l'écran de gestion "Groupe primaire", volontairement inchangé) : celui-ci
// alimente uniquement les filtres "Groupe" des écrans Suivi des distributions / Gestion des Kits,
// ouverts à admin/moyens_generaux/comptabilite/caissier/scolarite — aucune permission granulaire
// créée, même convention que les deux autres routes de ce fichier (authenticateToken seul).
//
// Différences volontaires avec /api/decoupage/classes :
//   - INCLUT les groupes primaires (g.est_primaire = true) — /decoupage/classes les exclut car
//     conçu pour l'écran "Gestion des groupes pédagogiques", pas pour un filtre générique ; sur les
//     données réelles actuelles, la quasi-totalité des groupes existants SONT des groupes
//     primaires (vérifié à l'audit) — les exclure rendrait ce filtre vide dans la plupart des cas.
//   - Ne retourne que {id, nom} : pas d'agrégats (effectifs, taux de remplissage...) inutiles à un
//     simple filtre.
//
// Scoping site : classe/groupe/filiere/departement ne portent aucune colonne site_id (vérifié par
// introspection) — seule `etudiant.site_id` permet d'attribuer un groupe à un site. Un groupe est
// donc rattaché au site s'il a ou a eu au moins un étudiant de ce site (position courante
// etudiant.groupe_id OU position historique via historique_inscription.groupe_id — même principe
// à 2 sources que classes.controller.js) — jamais un COUNT/HAVING, jamais un INNER JOIN etudiant
// qui exclurait un groupe légitime mais actuellement vide : la vérification est un pur test
// d'existence (EXISTS), qui n'écarte du filtre que les groupes n'ayant JAMAIS eu le moindre
// étudiant de ce site (limite structurelle du modèle de données, pas une donnée inventée).
exports.getGroupesParAnnee = async (req, res) => {
  const client = await db.connect();
  try {
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user?.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }
    if (!siteId) {
      return res.status(400).json({ success: false, message: 'Site de l\'agent introuvable.' });
    }

    const result = await client.query(
      `SELECT DISTINCT g.id, g.nom
       FROM classe c
       JOIN groupe g ON g.classe_id = c.id
       JOIN filiere f ON f.id = c.filiere_id
       JOIN departement d ON d.id = f.departement_id
       WHERE c.annee_academique_id = $1
         AND (
           EXISTS (SELECT 1 FROM etudiant e WHERE e.groupe_id = g.id AND e.site_id = $2)
           OR EXISTS (
             SELECT 1 FROM historique_inscription h
             JOIN etudiant e2 ON e2.id = h.etudiant_id
             WHERE h.groupe_id = g.id AND e2.site_id = $2
           )
         )
         AND ($3::int IS NULL OR d.ecole_id = $3)
       ORDER BY g.nom`,
      [anneeAcademiqueId, siteId, ecoleId]
    );

    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur récupération groupes par année:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};
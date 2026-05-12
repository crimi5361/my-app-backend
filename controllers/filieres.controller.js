const db = require('../config/db.config');

// ─── Helper : Récupérer l'année académique en cours du département ────────────
const getAnneeAcademiqueEnCours = async (departementId, client = null) => {
  const query = `
    SELECT id FROM public.anneeacademique 
    WHERE etat = 'en cour' AND departement_id = $1 
    LIMIT 1
  `;
  const result = client
    ? await client.query(query, [departementId])
    : await db.query(query, [departementId]);

  if (result.rows.length === 0) {
    throw new Error('Aucune année académique en cours pour votre département.');
  }
  return result.rows[0].id;
};

// ─── Helper : Récupérer le département de l'utilisateur ──────────────────────
const getDepartementFromUser = (req) => {
  if (!req.user) throw new Error('Utilisateur non authentifié.');
  const departementId = req.user.departement_id;
  if (!departementId) throw new Error('Utilisateur non rattaché à un département.');
  return departementId;
};

// ─── GET toutes les filières (pour les selects) ───────────────────────────────
exports.getAllFilieres = async (req, res) => {
  try {
    const departementId = getDepartementFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCours(departementId);

    const result = await db.query(`
      SELECT DISTINCT
        f.id,
        f.nom,
        f.sigle,
        f.type_filiere_id,
        tf.libelle     AS typefiliere_libelle,
        tf.description AS typefiliere_description
      FROM public.filiere f
      JOIN public.typefiliere tf ON f.type_filiere_id = tf.id
      JOIN public.niveau n       ON n.filiere_id = f.id
      WHERE n.anneeacademique_id = $1
        AND n.departement_id = $2
      ORDER BY f.nom
    `, [anneeAcademiqueId, departementId]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur getAllFilieres:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── GET filières pour le tableau ────────────────────────────────────────────
exports.getAllFilieresTable = async (req, res) => {
  try {
    const departementId = getDepartementFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCours(departementId);

    const result = await db.query(`
      SELECT
        f.id,
        f.nom,
        f.sigle,
        tf.id           AS typefiliere_id,
        tf.libelle      AS typefiliere_libelle,
        tf.description  AS typefiliere_description,
        COALESCE(
          json_agg(
            json_build_object(
              'id',             n.id,
              'libelle',        n.libelle,
              'prix_formation', n.prix_formation
            )
          ) FILTER (WHERE n.id IS NOT NULL),
          '[]'
        ) AS niveaux
      FROM public.filiere f
      JOIN public.typefiliere tf ON f.type_filiere_id = tf.id
      LEFT JOIN public.niveau n
        ON n.filiere_id = f.id
        AND n.anneeacademique_id = $1
        AND n.departement_id = $2
      WHERE EXISTS (
        SELECT 1 FROM public.niveau n2
        WHERE n2.filiere_id = f.id
          AND n2.anneeacademique_id = $1
          AND n2.departement_id = $2
      )
      GROUP BY f.id, f.nom, f.sigle, tf.id, tf.libelle, tf.description
      ORDER BY f.nom
    `, [anneeAcademiqueId, departementId]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur getAllFilieresTable:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── POST créer une filière AVEC ses niveaux ─────────────────────────────────
exports.createFiliere = async (req, res) => {
  const { nom, sigle, type_filiere_id, niveaux } = req.body;

  if (!nom || !sigle || !type_filiere_id) {
    return res.status(400).json({ message: 'Les champs nom, sigle et type_filiere_id sont requis.' });
  }
  if (!niveaux || niveaux.length === 0) {
    return res.status(400).json({ message: 'Au moins un niveau est requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const departementId = getDepartementFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCours(departementId, client);

    // Vérifier doublon
    const existing = await client.query(`
      SELECT f.id FROM public.filiere f
      JOIN public.niveau n ON n.filiere_id = f.id
      WHERE f.nom = $1
        AND n.departement_id = $2
        AND n.anneeacademique_id = $3
      LIMIT 1
    `, [nom, departementId, anneeAcademiqueId]);

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Cette filière existe déjà pour votre département cette année.' });
    }

    // Insérer la filière
    const filiereResult = await client.query(`
      INSERT INTO public.filiere (nom, sigle, type_filiere_id)
      VALUES ($1, $2, $3)
      RETURNING id, nom, sigle, type_filiere_id
    `, [nom, sigle, type_filiere_id]);

    const filiere = filiereResult.rows[0];

    // Insérer les niveaux
    const niveauxInseres = [];
    for (const niveau of niveaux) {
      const niveauResult = await client.query(`
        INSERT INTO public.niveau (libelle, prix_formation, filiere_id, departement_id, anneeacademique_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, libelle, prix_formation, filiere_id
      `, [niveau.libelle, niveau.prix_formation, filiere.id, departementId, anneeAcademiqueId]);
      niveauxInseres.push(niveauResult.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Filière et niveaux créés avec succès.',
      filiere: { ...filiere, niveaux: niveauxInseres, departement_id: departementId, annee_academique_id: anneeAcademiqueId }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur createFiliere:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// ─── PUT modifier une filière ─────────────────────────────────────────────────
exports.updateFiliere = async (req, res) => {
  const { id } = req.params;
  const { nom, sigle, type_filiere_id, niveaux } = req.body;

  if (!nom || !sigle || !type_filiere_id) {
    return res.status(400).json({ message: 'Les champs nom, sigle et type_filiere_id sont requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const departementId = getDepartementFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCours(departementId, client);

    // Vérifier que la filière existe pour ce département/année
    const check = await client.query(`
      SELECT f.id FROM public.filiere f
      JOIN public.niveau n ON n.filiere_id = f.id
      WHERE f.id = $1
        AND n.departement_id = $2
        AND n.anneeacademique_id = $3
      LIMIT 1
    `, [id, departementId, anneeAcademiqueId]);

    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Filière introuvable ou non accessible.' });
    }

    // Mettre à jour
    await client.query(`
      UPDATE public.filiere SET nom = $1, sigle = $2, type_filiere_id = $3 WHERE id = $4
    `, [nom, sigle, type_filiere_id, id]);

    // Remplacer les niveaux
    await client.query(`
      DELETE FROM public.niveau
      WHERE filiere_id = $1 AND departement_id = $2 AND anneeacademique_id = $3
    `, [id, departementId, anneeAcademiqueId]);

    const niveauxInseres = [];
    for (const niveau of niveaux || []) {
      const r = await client.query(`
        INSERT INTO public.niveau (libelle, prix_formation, filiere_id, departement_id, anneeacademique_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, libelle, prix_formation, filiere_id
      `, [niveau.libelle, niveau.prix_formation, id, departementId, anneeAcademiqueId]);
      niveauxInseres.push(r.rows[0]);
    }

    await client.query('COMMIT');
    res.status(200).json({
      message: 'Filière mise à jour avec succès.',
      filiere: { id, nom, sigle, type_filiere_id, niveaux: niveauxInseres }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur updateFiliere:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// ─── DELETE supprimer une filière ─────────────────────────────────────────────
exports.deleteFiliere = async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const departementId = getDepartementFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCours(departementId, client);

    const deleteResult = await client.query(`
      DELETE FROM public.niveau
      WHERE filiere_id = $1 AND anneeacademique_id = $2 AND departement_id = $3
      RETURNING id
    `, [id, anneeAcademiqueId, departementId]);

    if (deleteResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Aucun niveau trouvé pour cette filière.' });
    }

    // Supprimer la filière si plus aucun niveau lié
    const remaining = await client.query(
      `SELECT id FROM public.niveau WHERE filiere_id = $1`, [id]
    );
    if (remaining.rows.length === 0) {
      await client.query(`DELETE FROM public.filiere WHERE id = $1`, [id]);
    }

    await client.query('COMMIT');
    res.status(200).json({ message: 'Filière supprimée avec succès.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur deleteFiliere:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  } finally {
    client.release();
  }
};
const db = require('../config/db.config');
const { ensureTarifForNiveau } = require('./tarif.controller');

// ─── Helper : Récupérer l'année académique en cours pour un site ──────────────
const getAnneeAcademiqueEnCoursPourSite = async (siteId, client = null) => {
  const query = `
    SELECT a.id FROM public.anneeacademique a
    JOIN public.anneeacademique_site s ON s.anneeacademique_id = a.id
    WHERE s.etat = 'en cour' AND s.site_id = $1
    LIMIT 1
  `;
  const result = client
    ? await client.query(query, [siteId])
    : await db.query(query, [siteId]);

  if (result.rows.length === 0) {
    throw new Error('Aucune année académique en cours pour votre site.');
  }
  return result.rows[0].id;
};

// ─── Helper : Récupérer le site de l'utilisateur ──────────────────────────────
const getSiteFromUser = (req) => {
  if (!req.user) throw new Error('Utilisateur non authentifié.');
  const siteId = req.user.departement_id;
  if (!siteId) throw new Error('Utilisateur non rattaché à un site.');
  return siteId;
};

// ─── GET toutes les filières (pour les selects) ───────────────────────────────
exports.getAllFilieres = async (req, res) => {
  try {
    const siteId = getSiteFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCoursPourSite(siteId);

    const result = await db.query(`
      SELECT DISTINCT
        f.id,
        f.nom,
        f.sigle,
        f.type_filiere_id,
        f.departement_id,
        tf.libelle     AS typefiliere_libelle,
        tf.description AS typefiliere_description
      FROM public.filiere f
      JOIN public.typefiliere tf ON f.type_filiere_id = tf.id
      JOIN public.niveau n       ON n.filiere_id = f.id
      WHERE n.anneeacademique_id = $1
        AND n.site_id = $2
      ORDER BY f.nom
    `, [anneeAcademiqueId, siteId]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur getAllFilieres:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── GET filières pour le tableau ────────────────────────────────────────────
exports.getAllFilieresTable = async (req, res) => {
  try {
    const siteId = getSiteFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCoursPourSite(siteId);

    const result = await db.query(`
      SELECT
        f.id,
        f.nom,
        f.sigle,
        f.departement_id,
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
        AND n.site_id = $2
      WHERE EXISTS (
        SELECT 1 FROM public.niveau n2
        WHERE n2.filiere_id = f.id
          AND n2.anneeacademique_id = $1
          AND n2.site_id = $2
      )
      GROUP BY f.id, f.nom, f.sigle, f.departement_id, tf.id, tf.libelle, tf.description
      ORDER BY f.nom
    `, [anneeAcademiqueId, siteId]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur getAllFilieresTable:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── POST créer une filière AVEC ses niveaux ─────────────────────────────────
exports.createFiliere = async (req, res) => {
  const { nom, sigle, type_filiere_id, departement_id, niveaux } = req.body;

  if (!nom || !sigle || !type_filiere_id) {
    return res.status(400).json({ message: 'Les champs nom, sigle et type_filiere_id sont requis.' });
  }
  if (!niveaux || niveaux.length === 0) {
    return res.status(400).json({ message: 'Au moins un niveau est requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const siteId = getSiteFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCoursPourSite(siteId, client);

    // Vérifier doublon
    const existing = await client.query(`
      SELECT f.id FROM public.filiere f
      JOIN public.niveau n ON n.filiere_id = f.id
      WHERE f.nom = $1
        AND n.site_id = $2
        AND n.anneeacademique_id = $3
      LIMIT 1
    `, [nom, siteId, anneeAcademiqueId]);

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Cette filière existe déjà pour votre site cette année.' });
    }

    // Insérer la filière (departement_id = département académique, optionnel tant que le mapping métier n'est pas fourni)
    const filiereResult = await client.query(`
      INSERT INTO public.filiere (nom, sigle, type_filiere_id, departement_id)
      VALUES ($1, $2, $3, $4)
      RETURNING id, nom, sigle, type_filiere_id, departement_id
    `, [nom, sigle, type_filiere_id, departement_id || null]);

    const filiere = filiereResult.rows[0];

    // Insérer les niveaux + leur tarif (montant Affecté standard + montant Non affecté
    // paramétré ici via prix_formation, sauf niveaux toujours-non-affectés à montant fixe)
    const niveauxInseres = [];
    for (const niveau of niveaux) {
      const niveauResult = await client.query(`
        INSERT INTO public.niveau (libelle, prix_formation, filiere_id, site_id, anneeacademique_id, type_filiere)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, libelle, prix_formation, filiere_id
      `, [niveau.libelle, niveau.prix_formation, filiere.id, siteId, anneeAcademiqueId, String(type_filiere_id)]);
      const niveauCree = niveauResult.rows[0];
      await ensureTarifForNiveau(niveauCree.id, niveauCree.libelle, niveauCree.prix_formation, client);
      niveauxInseres.push(niveauCree);
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Filière et niveaux créés avec succès.',
      filiere: { ...filiere, niveaux: niveauxInseres, departement_id_site: siteId, annee_academique_id: anneeAcademiqueId }
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
  const { nom, sigle, type_filiere_id, departement_id, niveaux } = req.body;

  if (!nom || !sigle || !type_filiere_id) {
    return res.status(400).json({ message: 'Les champs nom, sigle et type_filiere_id sont requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const siteId = getSiteFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCoursPourSite(siteId, client);

    // Vérifier que la filière existe pour ce site/année
    const check = await client.query(`
      SELECT f.id FROM public.filiere f
      JOIN public.niveau n ON n.filiere_id = f.id
      WHERE f.id = $1
        AND n.site_id = $2
        AND n.anneeacademique_id = $3
      LIMIT 1
    `, [id, siteId, anneeAcademiqueId]);

    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Filière introuvable ou non accessible.' });
    }

    // Mettre à jour
    await client.query(`
      UPDATE public.filiere SET nom = $1, sigle = $2, type_filiere_id = $3, departement_id = COALESCE($4, departement_id) WHERE id = $5
    `, [nom, sigle, type_filiere_id, departement_id || null, id]);

    // Les niveaux sont entièrement recréés (nouveaux id) à chaque modification de filière.
    // On mémorise d'abord quelles maquettes pointaient sur quel libellé de niveau, pour
    // les rebrancher sur le nouveau niveau de même libellé une fois recréé — sinon
    // maquette.niveau_id se retrouve orphelin (pas de FK dessus, donc pas d'erreur, mais
    // niveau_libelle devient null partout où la maquette est affichée).
    const maquettesAReassocier = await client.query(`
      SELECT m.id AS maquette_id, n.libelle
      FROM public.maquette m
      JOIN public.niveau n ON n.id = m.niveau_id
      WHERE n.filiere_id = $1 AND n.site_id = $2 AND n.anneeacademique_id = $3
    `, [id, siteId, anneeAcademiqueId]);

    // Remplacer les niveaux — supprimer d'abord leurs tarifs (sinon la contrainte de clé
    // étrangère tarif_niveau_id_fkey bloque la suppression des niveaux qui en ont un)
    await client.query(`
      DELETE FROM public.tarif
      WHERE niveau_id IN (
        SELECT id FROM public.niveau WHERE filiere_id = $1 AND site_id = $2 AND anneeacademique_id = $3
      )
    `, [id, siteId, anneeAcademiqueId]);
    await client.query(`
      DELETE FROM public.niveau
      WHERE filiere_id = $1 AND site_id = $2 AND anneeacademique_id = $3
    `, [id, siteId, anneeAcademiqueId]);

    const niveauxInseres = [];
    for (const niveau of niveaux || []) {
      const r = await client.query(`
        INSERT INTO public.niveau (libelle, prix_formation, filiere_id, site_id, anneeacademique_id, type_filiere)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, libelle, prix_formation, filiere_id
      `, [niveau.libelle, niveau.prix_formation, id, siteId, anneeAcademiqueId, String(type_filiere_id)]);
      const niveauCree = r.rows[0];
      await ensureTarifForNiveau(niveauCree.id, niveauCree.libelle, niveauCree.prix_formation, client);

      // Rebrancher les maquettes qui pointaient sur l'ancien niveau de même libellé
      const aReassocier = maquettesAReassocier.rows.filter(m => m.libelle === niveauCree.libelle);
      if (aReassocier.length > 0) {
        await client.query(
          `UPDATE public.maquette SET niveau_id = $1 WHERE id = ANY($2::int[])`,
          [niveauCree.id, aReassocier.map(m => m.maquette_id)]
        );
      }
      niveauxInseres.push(niveauCree);
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

    const siteId = getSiteFromUser(req);
    const anneeAcademiqueId = await getAnneeAcademiqueEnCoursPourSite(siteId, client);

    // Supprimer d'abord les tarifs des niveaux visés (sinon tarif_niveau_id_fkey bloque)
    await client.query(`
      DELETE FROM public.tarif
      WHERE niveau_id IN (
        SELECT id FROM public.niveau WHERE filiere_id = $1 AND anneeacademique_id = $2 AND site_id = $3
      )
    `, [id, anneeAcademiqueId, siteId]);

    const deleteResult = await client.query(`
      DELETE FROM public.niveau
      WHERE filiere_id = $1 AND anneeacademique_id = $2 AND site_id = $3
      RETURNING id
    `, [id, anneeAcademiqueId, siteId]);

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

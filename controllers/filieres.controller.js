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

// Exportés pour être réutilisés par niveau.controller.js (CRUD niveau indépendant) sans dupliquer
// la résolution site/année de l'utilisateur connecté.
exports.getSiteFromUser = getSiteFromUser;
exports.getAnneeAcademiqueEnCoursPourSite = getAnneeAcademiqueEnCoursPourSite;

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
        f.filiere_mere_id,
        fm.nom          AS filiere_mere_nom,
        tf.id           AS typefiliere_id,
        tf.libelle      AS typefiliere_libelle,
        tf.description  AS typefiliere_description,
        COALESCE(
          json_agg(
            json_build_object(
              'id',                n.id,
              'libelle',           n.libelle,
              'prix_formation',    n.prix_formation,
              'ordre',             n.ordre,
              'niveau_suivant_id', n.niveau_suivant_id
            )
          ) FILTER (WHERE n.id IS NOT NULL),
          '[]'
        ) AS niveaux
      FROM public.filiere f
      JOIN public.typefiliere tf ON f.type_filiere_id = tf.id
      LEFT JOIN public.filiere fm ON fm.id = f.filiere_mere_id
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
      GROUP BY f.id, f.nom, f.sigle, f.departement_id, f.filiere_mere_id, fm.nom, tf.id, tf.libelle, tf.description
      ORDER BY f.nom
    `, [anneeAcademiqueId, siteId]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur getAllFilieresTable:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── POST créer une filière AVEC ses niveaux ─────────────────────────────────
// Les niveaux fournis sont chaînés automatiquement dans l'ordre du tableau reçu (ordre = position
// 1-based, niveau_suivant_id = id du niveau suivant dans le tableau) — élimine le besoin de
// configurer niveau_suivant_id manuellement en base pour une progression simple au sein d'une
// même filière. filiere_mere_id (optionnel) déclare explicitement que cette filière est une
// option d'une filière existante (ex. "SCIENCES JURIDIQUES (OPTION PRIVE)" → filière-mère
// "SCIENCES JURIDIQUES"), en complément du filet de sécurité par nom déjà utilisé en réinscription.
exports.createFiliere = async (req, res) => {
  const { nom, sigle, type_filiere_id, departement_id, filiere_mere_id, niveaux } = req.body;

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

    if (filiere_mere_id) {
      const mereCheck = await client.query('SELECT id FROM public.filiere WHERE id = $1', [filiere_mere_id]);
      if (mereCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Filière-mère introuvable.' });
      }
    }

    // Insérer la filière (departement_id = département académique, optionnel tant que le mapping métier n'est pas fourni)
    const filiereResult = await client.query(`
      INSERT INTO public.filiere (nom, sigle, type_filiere_id, departement_id, filiere_mere_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, nom, sigle, type_filiere_id, departement_id, filiere_mere_id
    `, [nom, sigle, type_filiere_id, departement_id || null, filiere_mere_id || null]);

    const filiere = filiereResult.rows[0];

    // Insérer les niveaux + leur tarif (montant Affecté standard + montant Non affecté
    // paramétré ici via prix_formation, sauf niveaux toujours-non-affectés à montant fixe),
    // en chaînant niveau_suivant_id sur le niveau suivant du tableau au fur et à mesure.
    const niveauxInseres = [];
    let niveauPrecedentId = null;
    for (let index = 0; index < niveaux.length; index++) {
      const niveau = niveaux[index];
      const niveauResult = await client.query(`
        INSERT INTO public.niveau (libelle, prix_formation, filiere_id, site_id, anneeacademique_id, type_filiere, ordre)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, libelle, prix_formation, filiere_id, ordre
      `, [niveau.libelle, niveau.prix_formation, filiere.id, siteId, anneeAcademiqueId, String(type_filiere_id), index + 1]);
      const niveauCree = niveauResult.rows[0];
      await ensureTarifForNiveau(niveauCree.id, niveauCree.libelle, niveauCree.prix_formation, client);

      if (niveauPrecedentId) {
        await client.query('UPDATE public.niveau SET niveau_suivant_id = $1 WHERE id = $2', [niveauCree.id, niveauPrecedentId]);
      }
      niveauPrecedentId = niveauCree.id;
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
// ✅ Simplifié : ne touche plus jamais aux niveaux (l'ancien comportement recréait tous les
// niveaux avec de nouveaux id à chaque édition, cassant silencieusement toute référence vivante —
// étudiant.niveau_id, classe.niveau_id, inscription_annuelle.niveau_id — sans autre garde-fou
// qu'une ré-association fragile des maquettes par libellé). La gestion des niveaux passe
// désormais exclusivement par niveau.controller.js (POST/PUT/DELETE /api/niveaux), qui modifie
// un niveau existant EN PLACE (UPDATE, jamais DELETE+recréation).
exports.updateFiliere = async (req, res) => {
  const { id } = req.params;
  const { nom, sigle, type_filiere_id, departement_id, filiere_mere_id } = req.body;

  if (!nom || !sigle || !type_filiere_id) {
    return res.status(400).json({ message: 'Les champs nom, sigle et type_filiere_id sont requis.' });
  }

  try {
    if (filiere_mere_id && parseInt(filiere_mere_id, 10) === parseInt(id, 10)) {
      return res.status(400).json({ message: 'Une filière ne peut pas être sa propre filière-mère.' });
    }

    const result = await db.query(`
      UPDATE public.filiere
      SET nom = $1, sigle = $2, type_filiere_id = $3,
          departement_id = COALESCE($4, departement_id),
          filiere_mere_id = $5
      WHERE id = $6
      RETURNING id, nom, sigle, type_filiere_id, departement_id, filiere_mere_id
    `, [nom, sigle, type_filiere_id, departement_id || null, filiere_mere_id || null, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Filière introuvable.' });
    }

    res.status(200).json({ message: 'Filière mise à jour avec succès.', filiere: result.rows[0] });

  } catch (error) {
    console.error('Erreur updateFiliere:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── DELETE supprimer une filière ─────────────────────────────────────────────
// ✅ Réactivé avec garde-fous (l'ancienne implémentation supprimait tarifs+niveaux du site/année
// courants sans vérifier aucune référence vivante — etudiant, classe, maquette, historique,
// reinscription — ce qui l'a laissée désactivée côté route). La suppression d'un niveau passe
// désormais exclusivement par niveau.controller.js::deleteNiveau (qui a son propre garde-fou) :
// une filière ne peut être supprimée que lorsqu'elle n'a plus aucun niveau (toutes années/sites
// confondus) et qu'aucune autre filière ne la référence comme filière-mère.
exports.deleteFiliere = async (req, res) => {
  const { id } = req.params;
  try {
    const niveauxRestants = await db.query('SELECT id FROM public.niveau WHERE filiere_id = $1 LIMIT 1', [id]);
    if (niveauxRestants.rows.length > 0) {
      return res.status(409).json({
        message: 'Impossible de supprimer cette filière : des niveaux y sont encore rattachés. Supprimez-les d\'abord.'
      });
    }

    const optionsRestantes = await db.query('SELECT id FROM public.filiere WHERE filiere_mere_id = $1 LIMIT 1', [id]);
    if (optionsRestantes.rows.length > 0) {
      return res.status(409).json({
        message: 'Impossible de supprimer cette filière : d\'autres filières la référencent comme filière-mère.'
      });
    }

    const result = await db.query('DELETE FROM public.filiere WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Filière introuvable.' });
    }
    res.status(200).json({ message: 'Filière supprimée avec succès.' });

  } catch (error) {
    console.error('Erreur deleteFiliere:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── Helper interne : duplique les niveaux d'UNE filière d'une année/site source vers une
// année/site cible (tarifs + maquettes + chaînage niveau_suivant_id re-pointé sur les NOUVEAUX
// id). N'affecte jamais les niveaux sources. Utilisé par dupliquerFiliere, y compris en cascade
// pour les filières-options. Retourne les niveaux créés.
const dupliquerNiveauxDeFiliere = async (client, filiereId, typeFiliereId, siteSourceId, anneeSourceId, siteCibleId, anneeCibleId) => {
  const niveauxSource = await client.query(`
    SELECT id, libelle, prix_formation, ordre, niveau_suivant_id
    FROM public.niveau
    WHERE filiere_id = $1 AND site_id = $2 AND anneeacademique_id = $3
    ORDER BY ordre NULLS LAST, id
  `, [filiereId, siteSourceId, anneeSourceId]);

  if (niveauxSource.rows.length === 0) return [];

  const maquettesSource = await client.query(
    `SELECT niveau_id, parcour FROM public.maquette WHERE filiere_id = $1 AND anneeacademique_id = $2`,
    [filiereId, anneeSourceId]
  );
  const parcourParNiveau = new Map(maquettesSource.rows.map(m => [m.niveau_id, m.parcour]));

  const ancienVersNouveau = new Map();
  const niveauxCrees = [];
  for (const niv of niveauxSource.rows) {
    const r = await client.query(`
      INSERT INTO public.niveau (libelle, prix_formation, filiere_id, site_id, anneeacademique_id, type_filiere, ordre)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, libelle, prix_formation, ordre
    `, [niv.libelle, niv.prix_formation, filiereId, siteCibleId, anneeCibleId, String(typeFiliereId), niv.ordre]);
    const nouveauNiveau = r.rows[0];
    ancienVersNouveau.set(niv.id, nouveauNiveau.id);
    await ensureTarifForNiveau(nouveauNiveau.id, nouveauNiveau.libelle, nouveauNiveau.prix_formation, client);

    const parcour = parcourParNiveau.get(niv.id);
    if (parcour) {
      await client.query(
        'INSERT INTO public.maquette (filiere_id, niveau_id, anneeacademique_id, parcour, date_creation) VALUES ($1, $2, $3, $4, NOW())',
        [filiereId, nouveauNiveau.id, anneeCibleId, parcour]
      );
    }
    niveauxCrees.push({ ...nouveauNiveau, niveau_suivant_id_source: niv.niveau_suivant_id });
  }

  // Re-chaîner niveau_suivant_id sur les NOUVEAUX id (un chaînage vers un niveau hors de cette
  // filière — ex. cross-filière — n'est pas repointé automatiquement, à relier manuellement).
  for (const niv of niveauxCrees) {
    if (niv.niveau_suivant_id_source && ancienVersNouveau.has(niv.niveau_suivant_id_source)) {
      await client.query('UPDATE public.niveau SET niveau_suivant_id = $1 WHERE id = $2', [
        ancienVersNouveau.get(niv.niveau_suivant_id_source), niv.id
      ]);
    }
  }

  return niveauxCrees.map(({ niveau_suivant_id_source, ...rest }) => rest);
};

// ─── POST dupliquer une filière (niveaux + tarifs + maquettes + chaînage) vers une nouvelle
// année académique — sécurise la préparation de rentrée en éliminant la recréation manuelle
// filière par filière. `dupliquer_options: true` duplique en cascade les filières-options
// (filiere_mere_id = cette filière) vers la même année cible.
exports.dupliquerFiliere = async (req, res) => {
  const { id } = req.params;
  const { annee_academique_cible_id, site_id, annee_academique_source_id, dupliquer_options } = req.body;

  if (!annee_academique_cible_id) {
    return res.status(400).json({ message: 'annee_academique_cible_id est requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const siteId = site_id || getSiteFromUser(req);
    const anneeSourceId = annee_academique_source_id || await getAnneeAcademiqueEnCoursPourSite(siteId, client);

    const filiereCheck = await client.query(
      'SELECT id, nom, sigle, type_filiere_id FROM public.filiere WHERE id = $1', [id]
    );
    if (filiereCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Filière introuvable.' });
    }
    const filiereSource = filiereCheck.rows[0];

    const anneeCibleCheck = await client.query('SELECT id FROM public.anneeacademique WHERE id = $1', [annee_academique_cible_id]);
    if (anneeCibleCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Année académique cible introuvable.' });
    }

    const dejaPresent = await client.query(
      'SELECT id FROM public.niveau WHERE filiere_id = $1 AND site_id = $2 AND anneeacademique_id = $3 LIMIT 1',
      [id, siteId, annee_academique_cible_id]
    );
    if (dejaPresent.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Cette filière a déjà des niveaux configurés pour cette année/site.' });
    }

    const niveauxCrees = await dupliquerNiveauxDeFiliere(
      client, id, filiereSource.type_filiere_id, siteId, anneeSourceId, siteId, annee_academique_cible_id
    );
    if (niveauxCrees.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: `Aucun niveau trouvé pour "${filiereSource.nom}" sur l'année source.` });
    }

    const resultatOptions = [];
    if (dupliquer_options) {
      const options = await client.query('SELECT id, nom, type_filiere_id FROM public.filiere WHERE filiere_mere_id = $1', [id]);
      for (const option of options.rows) {
        const niveauxOption = await dupliquerNiveauxDeFiliere(
          client, option.id, option.type_filiere_id, siteId, anneeSourceId, siteId, annee_academique_cible_id
        );
        resultatOptions.push({ filiere_id: option.id, nom: option.nom, niveaux: niveauxOption });
      }
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: `Filière "${filiereSource.nom}" dupliquée avec succès (${niveauxCrees.length} niveau(x))${resultatOptions.length ? ` + ${resultatOptions.length} option(s)` : ''}.`,
      filiere: { id: filiereSource.id, nom: filiereSource.nom, niveaux: niveauxCrees },
      options: resultatOptions
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur dupliquerFiliere:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

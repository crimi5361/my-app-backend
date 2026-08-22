const db = require('../config/db.config');
const { ensureTarifForNiveau, getMontantAffecteStandard } = require('./tarif.controller');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

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

// ─── Chaînage automatique de niveau_suivant_id à CHAQUE création d'un niveau ──────────────────
// Avec une filière permanente préparée progressivement (une année peut n'ouvrir que Licence 1/2
// aujourd'hui, Licence 3 plus tard), on ne peut plus chaîner en un seul lot comme le faisait
// l'ancienne "duplication" en bloc — chaque création de niveau doit re-router les pointeurs
// concernés, dans les deux sens :
//  (a) même année : si le niveau d'ordre-1 existe déjà pour cette filière/site/année, il pointe
//      désormais vers le niveau nouvellement créé (chaînage provisoire, remplacé par (c) dès que
//      l'année suivante ouvre le niveau correspondant — voir le correctif niveau_suivant_id
//      cross-année déjà validé cette session dans dupliquerNiveauxDeFiliere) ;
//  (b) même année : si le niveau d'ordre+1 existe déjà (créé lors d'un appel précédent de la
//      préparation progressive), le niveau nouvellement créé pointe vers lui ;
//  (c) année précédente : le niveau qui précède celui-ci (même filière) sur la DERNIÈRE année
//      antérieure où cette filière a été configurée est re-pointé vers ce niveau — c'est le
//      chaînage réellement exploité par la progression en réinscription (un étudiant en Licence 1
//      cette année progresse vers la Licence 2 de l'année suivante, pas de la même année).
//
// Le prédécesseur (c) est cherché par `ordre` (fiable pour toute filière préparée via ce
// mécanisme, y compris des libellés non standards) — MAIS les niveaux légués (créés avant ce
// chantier) ont tous `ordre = NULL` en base. Repli explicite sur les libellés officiels de la
// grille académique (même table que LIBELLE_NIVEAU_SUIVANT de reinscription.controller.js — pas
// une nouvelle heuristique, la même règle métier déjà en production, dupliquée ici pour éviter
// une dépendance circulaire entre les deux contrôleurs) quand la recherche par ordre ne trouve
// rien. Un niveau au libellé non standard sans `ordre` renseigné ne sera simplement pas rechaîné
// automatiquement — comportement sûr (pas de résolution incorrecte), à corriger manuellement.
const LIBELLE_PREDECESSEUR = {
  'LICENCE 2': 'LICENCE 1', 'LICENCE 3': 'LICENCE 2', 'MASTER 1': 'LICENCE 3', 'MASTER 2': 'MASTER 1',
  'LICENCE 2 PRO': 'LICENCE 1 PRO', 'LICENCE 3 PRO': 'LICENCE 2 PRO', 'MASTER 1 PRO': 'LICENCE 3 PRO', 'MASTER 2 PRO': 'MASTER 1 PRO',
  'BTS 2': 'BTS 1',
};

const rechainerNiveauCree = async (client, { filiereId, siteId, anneeId, ordre, niveauId, libelle }) => {
  if (ordre) {
    const precedentMemeAnnee = await client.query(
      `SELECT id FROM public.niveau WHERE filiere_id = $1 AND site_id = $2 AND anneeacademique_id = $3 AND ordre = $4 LIMIT 1`,
      [filiereId, siteId, anneeId, ordre - 1]
    );
    if (precedentMemeAnnee.rows.length > 0) {
      await client.query('UPDATE public.niveau SET niveau_suivant_id = $1 WHERE id = $2', [niveauId, precedentMemeAnnee.rows[0].id]);
    }

    const suivantMemeAnnee = await client.query(
      `SELECT id FROM public.niveau WHERE filiere_id = $1 AND site_id = $2 AND anneeacademique_id = $3 AND ordre = $4 LIMIT 1`,
      [filiereId, siteId, anneeId, ordre + 1]
    );
    if (suivantMemeAnnee.rows.length > 0) {
      await client.query('UPDATE public.niveau SET niveau_suivant_id = $1 WHERE id = $2', [suivantMemeAnnee.rows[0].id, niveauId]);
    }
  }

  let anneePrecedente = { rows: [] };
  if (ordre && ordre > 1) {
    anneePrecedente = await client.query(
      `SELECT n.id FROM public.niveau n
       JOIN public.anneeacademique a ON a.id = n.anneeacademique_id
       JOIN public.anneeacademique aCible ON aCible.id = $4
       WHERE n.filiere_id = $1 AND n.site_id = $2 AND n.ordre = $3 AND a.annee < aCible.annee
       ORDER BY a.annee DESC LIMIT 1`,
      [filiereId, siteId, ordre - 1, anneeId]
    );
  }
  if (anneePrecedente.rows.length === 0) {
    const libellePredecesseur = LIBELLE_PREDECESSEUR[String(libelle || '').trim().toUpperCase()];
    if (libellePredecesseur) {
      anneePrecedente = await client.query(
        `SELECT n.id FROM public.niveau n
         JOIN public.anneeacademique a ON a.id = n.anneeacademique_id
         JOIN public.anneeacademique aCible ON aCible.id = $4
         WHERE n.filiere_id = $1 AND n.site_id = $2 AND UPPER(TRIM(n.libelle)) = $3 AND a.annee < aCible.annee
         ORDER BY a.annee DESC LIMIT 1`,
        [filiereId, siteId, libellePredecesseur, anneeId]
      );
    }
  }
  if (anneePrecedente.rows.length > 0) {
    await client.query('UPDATE public.niveau SET niveau_suivant_id = $1 WHERE id = $2', [niveauId, anneePrecedente.rows[0].id]);
  }
};
exports.rechainerNiveauCree = rechainerNiveauCree;

// ─── GET toutes les filières (pour les selects) ───────────────────────────────
exports.getAllFilieres = async (req, res) => {
  try {
    const siteId = getSiteFromUser(req);
    const ecoleId = getEcoleScopeFromUser(req);
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
        AND ($3::int IS NULL OR f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))
      ORDER BY f.nom
    `, [anneeAcademiqueId, siteId, ecoleId]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur getAllFilieres:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── GET filières pour le tableau ────────────────────────────────────────────
// `toutes=true` (nouveau, opt-in explicite) : réservé à la page "Gestion des filières" —
// retourne TOUTES les filières permanentes (même sans niveau pour l'année demandée), avec
// tarifs/parcours imbriqués et un indicateur `configuree`. Sans ce paramètre, comportement
// STRICTEMENT identique à avant (année en cours du site, filière absente si aucun niveau) :
// FormationCascadeSelect (admission agent, Vérification, changement de cycle en réinscription)
// dépend de ce comportement par défaut et ne doit voir AUCUNE régression.
exports.getAllFilieresTable = async (req, res) => {
  if (req.query.toutes === 'true') {
    return exports.getAllFilieresTablePreparation(req, res);
  }
  try {
    const siteId = getSiteFromUser(req);
    const ecoleId = getEcoleScopeFromUser(req);
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
      AND ($3::int IS NULL OR f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))
      GROUP BY f.id, f.nom, f.sigle, f.departement_id, f.filiere_mere_id, fm.nom, tf.id, tf.libelle, tf.description
      ORDER BY f.nom
    `, [anneeAcademiqueId, siteId, ecoleId]);

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur getAllFilieresTable:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── GET filières pour la page "Gestion des filières" / préparation de rentrée ────────────────
// Contrairement à getAllFilieresTable : retourne TOUTES les filières permanentes de l'école
// (aucun WHERE EXISTS), pour une année académique choisie (paramètre `anneeAcademiqueId`, défaut
// = année en cours du site). Chaque niveau embarque son tarif et ses parcours (maquette) pour
// cette année, et chaque filière porte un indicateur `configuree` — le tout pour afficher l'état
// de préparation directement dans la liste, sans ouvrir de drawer.
exports.getAllFilieresTablePreparation = async (req, res) => {
  try {
    const siteId = getSiteFromUser(req);
    const ecoleId = getEcoleScopeFromUser(req);
    const anneeAcademiqueId = req.query.anneeAcademiqueId
      ? parseInt(req.query.anneeAcademiqueId, 10)
      : await getAnneeAcademiqueEnCoursPourSite(siteId);

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
              'niveau_suivant_id', n.niveau_suivant_id,
              'tarif', json_build_object(
                'id',                            t.id,
                'montant_affecte',              t.montant_affecte,
                'montant_affecte_reinscription', t.montant_affecte_reinscription,
                'montant_non_affecte',          t.montant_non_affecte,
                'toujours_non_affecte',         t.toujours_non_affecte
              ),
              'parcours', COALESCE(m.parcours, '[]'::json)
            )
            ORDER BY n.ordre NULLS LAST, n.libelle
          ) FILTER (WHERE n.id IS NOT NULL),
          '[]'
        ) AS niveaux,
        COUNT(n.id) > 0 AS configuree
      FROM public.filiere f
      JOIN public.typefiliere tf ON f.type_filiere_id = tf.id
      LEFT JOIN public.filiere fm ON fm.id = f.filiere_mere_id
      LEFT JOIN public.niveau n
        ON n.filiere_id = f.id
        AND n.anneeacademique_id = $1
        AND n.site_id = $2
      LEFT JOIN public.tarif t ON t.niveau_id = n.id
      LEFT JOIN LATERAL (
        SELECT json_agg(mq.parcour ORDER BY mq.parcour) AS parcours
        FROM public.maquette mq
        WHERE mq.niveau_id = n.id AND mq.anneeacademique_id = $1
      ) m ON true
      WHERE ($3::int IS NULL OR f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))
      GROUP BY f.id, f.nom, f.sigle, f.departement_id, f.filiere_mere_id, fm.nom, tf.id, tf.libelle, tf.description
      ORDER BY f.nom
    `, [anneeAcademiqueId, siteId, ecoleId]);

    // Chantier tarification PRO — administration (2026-08-21) : enrichit chaque niveau du tarif
    // Affecté STANDARD (avant toute surcharge filière), calculé côté backend uniquement (voir
    // tarif.controller.js::getMontantAffecteStandard) — jamais dupliqué côté frontend. Permet à
    // l'écran d'administration d'afficher "Tarif standard : 250 000 FCFA" à titre de repère,
    // tout en éditant la valeur réellement configurée (tarif.montant_affecte).
    result.rows.forEach((f) => {
      (f.niveaux || []).forEach((n) => {
        if (n.tarif) n.tarif.montant_affecte_standard = getMontantAffecteStandard(n.libelle);
      });
    });

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Erreur getAllFilieresTablePreparation:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── GET catalogue des niveaux "conceptuels" d'une filière (préremplissage) ───────────────────
// Ne sert QUE de suggestion pour la page de préparation de rentrée : renvoie les niveaux de la
// DERNIÈRE année académique où cette filière a été configurée (peu importe laquelle), avec leurs
// parcours. L'utilisateur reste entièrement libre d'ajouter/retirer un niveau, changer son tarif
// ou ses parcours avant validation — ce catalogue ne contraint rien côté serveur.
exports.getCatalogueNiveauxFiliere = async (req, res) => {
  try {
    const { id } = req.params;
    const siteId = getSiteFromUser(req);

    const derniereAnnee = await db.query(`
      SELECT n.anneeacademique_id, a.annee
      FROM public.niveau n
      JOIN public.anneeacademique a ON a.id = n.anneeacademique_id
      WHERE n.filiere_id = $1 AND n.site_id = $2
      ORDER BY a.annee DESC
      LIMIT 1
    `, [id, siteId]);

    if (derniereAnnee.rows.length === 0) {
      return res.status(200).json({ annee_reference: null, niveaux: [] });
    }
    const { anneeacademique_id: anneeReferenceId, annee: anneeReferenceLabel } = derniereAnnee.rows[0];

    const niveaux = await db.query(`
      SELECT
        n.libelle, n.prix_formation, n.ordre,
        t.montant_affecte, t.montant_affecte_reinscription, t.montant_non_affecte, t.toujours_non_affecte,
        COALESCE(m.parcours, '[]'::json) AS parcours
      FROM public.niveau n
      LEFT JOIN public.tarif t ON t.niveau_id = n.id
      LEFT JOIN LATERAL (
        SELECT json_agg(mq.parcour ORDER BY mq.parcour) AS parcours
        FROM public.maquette mq
        WHERE mq.niveau_id = n.id AND mq.anneeacademique_id = n.anneeacademique_id
      ) m ON true
      WHERE n.filiere_id = $1 AND n.site_id = $2 AND n.anneeacademique_id = $3
      ORDER BY n.ordre NULLS LAST, n.libelle
    `, [id, siteId, anneeReferenceId]);

    res.status(200).json({ annee_reference: anneeReferenceLabel, niveaux: niveaux.rows });
  } catch (error) {
    console.error('Erreur getCatalogueNiveauxFiliere:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  }
};

// ─── POST configurer une filière pour une année académique (préparation de rentrée) ───────────
// Remplace la logique de "duplication" côté UI : ne crée AUCUN nouveau filiere_id (la filière est
// permanente), uniquement les niveaux/tarifs/parcours de l'année cible pour les niveaux COCHÉS par
// l'utilisateur — jamais tout le lot d'un coup. Peut être appelée plusieurs fois pour la même
// filière/année (préparation progressive : Licence 1/2 aujourd'hui, Licence 3 plus tard) — un
// niveau déjà configuré (même libellé, même filière/site/année) est ignoré, jamais recréé.
exports.configurerAnneeFiliere = async (req, res) => {
  const { id } = req.params;
  const { annee_academique_id, niveaux } = req.body;

  if (!annee_academique_id) {
    return res.status(400).json({ message: 'annee_academique_id est requis.' });
  }
  if (!Array.isArray(niveaux) || niveaux.length === 0) {
    return res.status(400).json({ message: 'Au moins un niveau à configurer est requis.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const siteId = getSiteFromUser(req);

    const filiereCheck = await client.query('SELECT id, nom, type_filiere_id FROM public.filiere WHERE id = $1', [id]);
    if (filiereCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Filière introuvable.' });
    }
    const filiere = filiereCheck.rows[0];

    const anneeCheck = await client.query('SELECT id, annee FROM public.anneeacademique WHERE id = $1', [annee_academique_id]);
    if (anneeCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Année académique introuvable.' });
    }

    const niveauxCrees = [];
    const niveauxIgnores = [];

    for (const demande of niveaux) {
      const { libelle, prix_formation, ordre, parcours } = demande;
      if (!libelle || !ordre) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Chaque niveau doit avoir un libellé et un ordre.' });
      }

      const dejaConfigure = await client.query(
        `SELECT id FROM public.niveau WHERE filiere_id = $1 AND site_id = $2 AND anneeacademique_id = $3 AND UPPER(TRIM(libelle)) = UPPER(TRIM($4)) LIMIT 1`,
        [id, siteId, annee_academique_id, libelle]
      );
      if (dejaConfigure.rows.length > 0) {
        niveauxIgnores.push({ libelle, raison: 'déjà configuré pour cette année' });
        continue;
      }

      const niveauResult = await client.query(`
        INSERT INTO public.niveau (libelle, prix_formation, filiere_id, site_id, anneeacademique_id, type_filiere, ordre)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, libelle, prix_formation, ordre
      `, [libelle, prix_formation || 0, id, siteId, annee_academique_id, String(filiere.type_filiere_id), ordre]);
      const niveauCree = niveauResult.rows[0];

      await ensureTarifForNiveau(niveauCree.id, niveauCree.libelle, niveauCree.prix_formation, client);
      if (demande.montant_affecte !== undefined || demande.montant_affecte_reinscription !== undefined ||
          demande.montant_non_affecte !== undefined || demande.toujours_non_affecte !== undefined) {
        await client.query(`
          UPDATE public.tarif SET
            montant_affecte = COALESCE($1, montant_affecte),
            montant_affecte_reinscription = COALESCE($2, montant_affecte_reinscription),
            montant_non_affecte = COALESCE($3, montant_non_affecte),
            toujours_non_affecte = COALESCE($4, toujours_non_affecte),
            updated_at = now()
          WHERE niveau_id = $5
        `, [
          demande.montant_affecte ?? null, demande.montant_affecte_reinscription ?? null,
          demande.montant_non_affecte ?? null, demande.toujours_non_affecte ?? null, niveauCree.id
        ]);
      }

      for (const parcour of (parcours || [])) {
        await client.query(
          'INSERT INTO public.maquette (filiere_id, niveau_id, anneeacademique_id, parcour, date_creation) VALUES ($1, $2, $3, $4, NOW())',
          [id, niveauCree.id, annee_academique_id, parcour]
        );
      }

      await rechainerNiveauCree(client, { filiereId: parseInt(id, 10), siteId, anneeId: annee_academique_id, ordre: niveauCree.ordre, niveauId: niveauCree.id, libelle: niveauCree.libelle });
      niveauxCrees.push(niveauCree);
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: `Filière "${filiere.nom}" configurée pour ${anneeCheck.rows[0].annee} (${niveauxCrees.length} niveau(x) créé(s)${niveauxIgnores.length ? `, ${niveauxIgnores.length} déjà présent(s)` : ''}).`,
      niveaux_crees: niveauxCrees,
      niveaux_ignores: niveauxIgnores
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur configurerAnneeFiliere:', error);
    res.status(500).json({ message: error.message || 'Erreur serveur.' });
  } finally {
    client.release();
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

    // Vérifier doublon — global et indépendant de l'année/niveau : une filière est un
    // référentiel permanent (une formation), jamais un objet propre à une rentrée. Comparer
    // uniquement via une jointure niveau+année laissait passer une filière déjà créée les
    // années précédentes (aucun niveau pour l'année cible au moment du check, donc aucun match) —
    // c'est le mécanisme exact qui a produit des filières dupliquées lors des rentrées passées.
    // Normalisation (TRIM+UPPER) pour ignorer les variations d'espaces/casse déjà observées
    // dans les données (ex. " GESTION COMMERCIALE" vs "GESTION COMMERCIALE").
    const existing = await client.query(`
      SELECT id, nom FROM public.filiere
      WHERE TRIM(UPPER(nom)) = TRIM(UPPER($1))
      LIMIT 1
    `, [nom]);

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: `Cette filière existe déjà (id ${existing.rows[0].id} — "${existing.rows[0].nom}"). Une filière ne doit jamais être recréée : utilisez « Dupliquer vers une année académique » pour lui ajouter les niveaux de la nouvelle rentrée.`
      });
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
      await rechainerNiveauCree(client, { filiereId: filiere.id, siteId, anneeId: anneeAcademiqueId, ordre: index + 1, niveauId: niveauCree.id, libelle: niveauCree.libelle });
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

  // Chantier tarification PRO (2026-08-21) §8 : tarifs des niveaux sources, pour reporter une
  // configuration Affecté spécifique par filière lors de la duplication vers la nouvelle année
  // (voir ensureTarifForNiveau — jamais perdue silencieusement, jamais ré-inventée si le tarif
  // source n'était que le standard).
  const tarifsSourceResult = await client.query(
    `SELECT niveau_id, montant_affecte, montant_affecte_reinscription, toujours_non_affecte
     FROM public.tarif WHERE niveau_id = ANY($1::int[])`,
    [niveauxSource.rows.map(n => n.id)]
  );
  const tarifParNiveauSource = new Map(tarifsSourceResult.rows.map(t => [t.niveau_id, t]));

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
    await ensureTarifForNiveau(nouveauNiveau.id, nouveauNiveau.libelle, nouveauNiveau.prix_formation, client, tarifParNiveauSource.get(niv.id) || null);

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

  // Re-chaîner aussi le niveau SOURCE (année précédente) vers le NIVEAU SUIVANT nouvellement
  // dupliqué (ex. l'ancien L1 doit pointer vers le nouveau L2, jamais vers le nouveau L1 — un
  // étudiant qui progresse normalement change de niveau, pas seulement d'année). Sans ce
  // repointage, un étudiant resté sur l'ancien niveau (pas encore réinscrit) voit sa progression
  // automatique (niveau.niveau_suivant_id, lu par reinscription.controller.js) continuer à
  // pointer vers l'ancien niveau suivant de l'année précédente au lieu du niveau fraîchement
  // dupliqué pour la nouvelle année — la cause du bug de classes dupliquées en réinscription.
  for (const niv of niveauxSource.rows) {
    if (niv.niveau_suivant_id && ancienVersNouveau.has(niv.niveau_suivant_id)) {
      await client.query('UPDATE public.niveau SET niveau_suivant_id = $1 WHERE id = $2', [
        ancienVersNouveau.get(niv.niveau_suivant_id), niv.id
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

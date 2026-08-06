// Découpage manuel des classes en groupes (Chantier 6, 2026-08-01).
// Remplace intégralement le brouillon précédent (jamais branché à l'application, cf. git log) —
// conçu ici pour des groupes nommés et dimensionnés individuellement par l'administrateur
// (ex. G1→40, G2→70, G3→60), pas un partage automatique égal.
const db = require('../config/db.config');
const {
  decouperClasse, creerGroupePedagogique, deplacerEtudiantsVersGroupe,
  modifierGroupePedagogique, supprimerGroupePedagogique,
} = require('../services/decoupageGroupe.service');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

// POST /classes/:classeId/groupes/repartir — body: { groupes: [{ nom, capacite_max }, ...], strategie? }
exports.decouperClasseEnGroupes = async (req, res) => {
  const client = await db.connect();
  try {
    const classeId = parseInt(req.params.classeId, 10);
    const { groupes, strategie } = req.body;

    if (!Number.isInteger(classeId)) {
      return res.status(400).json({ success: false, message: 'Identifiant de classe invalide.' });
    }

    await client.query('BEGIN');
    const resultat = await decouperClasse(client, {
      classeId,
      groupes,
      strategie,
      effectuePar: req.user?.id,
    });
    await client.query('COMMIT');

    res.status(201).json({ success: true, data: resultat });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur découpage classe en groupes:', error);
    // Erreurs de validation métier (classe déjà découpée, capacité insuffisante, etc.) renvoyées
    // telles quelles au client — ce sont des messages destinés à l'agent, pas des détails internes.
    res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// GET /classes/:classeId/groupes/etat — permet à l'écran de gestion de savoir si une classe est
// déjà découpée avant d'afficher le formulaire de découpage.
exports.getEtatDecoupage = async (req, res) => {
  const client = await db.connect();
  try {
    const classeId = parseInt(req.params.classeId, 10);
    if (!Number.isInteger(classeId)) {
      return res.status(400).json({ success: false, message: 'Identifiant de classe invalide.' });
    }

    const groupesResult = await client.query(
      `SELECT g.id, g.nom, g.capacite_max, COUNT(e.id) AS effectif
       FROM groupe g
       LEFT JOIN etudiant e ON e.groupe_id = g.id
       WHERE g.classe_id = $1
       GROUP BY g.id, g.nom, g.capacite_max
       ORDER BY g.nom`,
      [classeId]
    );

    const sansGroupeResult = await client.query(
      `SELECT COUNT(*) AS total FROM etudiant e
       JOIN classe c ON c.id = $1
       WHERE e.groupe_id IS NULL
         AND e.id_filiere = c.filiere_id AND e.niveau_id = c.niveau_id
         AND e.annee_academique_id = c.annee_academique_id
         AND e.curcus_id IS NOT DISTINCT FROM c.curcus_id`,
      [classeId]
    );

    res.status(200).json({
      success: true,
      data: {
        decoupee: groupesResult.rows.length > 0,
        groupes: groupesResult.rows,
        etudiants_sans_groupe: parseInt(sansGroupeResult.rows[0].total, 10),
      },
    });
  } catch (error) {
    console.error('Erreur récupération état découpage:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// Chantier 11 (2026-08-03) — sous-phase 3 : écran "Gestion des groupes". GET /classes?anneeAcademiqueId=X
// Ne liste QUE les classes de la nouvelle architecture (celles dotées d'un Groupe primaire) — les
// classes antérieures (années historiques, groupes attribués à l'ancienne) n'ont pas leur place
// sur ce nouvel écran, qui manipule des notions (primaire/pédagogique) qu'elles n'ont jamais eues.
// Même convention de scoping site/école que le reste de l'application (site = req.user.departement_id,
// mandatory ; école = getEcoleScopeFromUser, cumulatif optionnel).
exports.listerClassesGestionGroupes = async (req, res) => {
  const client = await db.connect();
  try {
    const { anneeAcademiqueId } = req.query;
    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    const result = await client.query(
      `SELECT
         c.id, c.nom, c.description,
         aa.annee AS annee_academique,
         ec.nom AS ecole,
         f.nom AS filiere,
         n.libelle AS niveau,
         pg.id AS groupe_primaire_id,
         (SELECT COUNT(*) FROM etudiant ep WHERE ep.groupe_id = pg.id) AS nb_non_repartis,
         (SELECT COUNT(*) FROM groupe gp WHERE gp.classe_id = c.id AND gp.est_primaire = false) AS nb_groupes_pedagogiques,
         (SELECT COUNT(*) FROM etudiant et JOIN groupe gt ON gt.id = et.groupe_id WHERE gt.classe_id = c.id) AS effectif_total
       FROM classe c
       JOIN groupe pg ON pg.classe_id = c.id AND pg.est_primaire = true
       JOIN filiere f ON f.id = c.filiere_id
       JOIN departement d ON d.id = f.departement_id
       JOIN ecole ec ON ec.id = d.ecole_id
       JOIN niveau n ON n.id = c.niveau_id
       JOIN anneeacademique aa ON aa.id = c.annee_academique_id
       WHERE c.annee_academique_id = $1
         AND EXISTS (
           SELECT 1 FROM etudiant e JOIN groupe g ON g.id = e.groupe_id
           WHERE g.classe_id = c.id AND e.site_id = $2
         )
         AND ($3::int IS NULL OR d.ecole_id = $3)
       ORDER BY f.nom, n.libelle, c.nom`,
      [anneeAcademiqueId, siteId, ecoleId]
    );

    res.status(200).json({
      success: true,
      data: result.rows.map((r) => ({
        ...r,
        nb_non_repartis: parseInt(r.nb_non_repartis, 10),
        nb_groupes_pedagogiques: parseInt(r.nb_groupes_pedagogiques, 10),
        effectif_total: parseInt(r.effectif_total, 10),
      })),
    });
  } catch (error) {
    console.error('Erreur liste classes (gestion des groupes):', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// GET /classes/:classeId — écran Manager : tout ce qu'il faut en un seul appel (bloc Groupe
// primaire avec liste nominative complète pour la recherche, blocs Groupes pédagogiques avec leur
// propre liste nominative) — pas d'appel supplémentaire nécessaire côté frontend.
exports.getDetailClasseGestionGroupes = async (req, res) => {
  const client = await db.connect();
  try {
    const classeId = parseInt(req.params.classeId, 10);
    if (!Number.isInteger(classeId)) {
      return res.status(400).json({ success: false, message: 'Identifiant de classe invalide.' });
    }

    const classeResult = await client.query(
      `SELECT c.id, c.nom, c.description, aa.annee AS annee_academique, ec.nom AS ecole,
              f.nom AS filiere, n.libelle AS niveau
       FROM classe c
       JOIN filiere f ON f.id = c.filiere_id
       JOIN departement d ON d.id = f.departement_id
       JOIN ecole ec ON ec.id = d.ecole_id
       JOIN niveau n ON n.id = c.niveau_id
       JOIN anneeacademique aa ON aa.id = c.annee_academique_id
       WHERE c.id = $1`,
      [classeId]
    );
    if (classeResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Classe introuvable.' });
    }

    const groupesResult = await client.query(
      'SELECT id, nom, capacite_max, est_primaire FROM groupe WHERE classe_id = $1 ORDER BY est_primaire DESC, nom',
      [classeId]
    );
    const primaire = groupesResult.rows.find((g) => g.est_primaire);
    if (!primaire) {
      return res.status(409).json({
        success: false,
        message: "Cette classe ne dispose pas d'un Groupe primaire — la gestion des groupes n'est disponible que pour les classes de la nouvelle architecture (2026-2027 et suivantes).",
      });
    }

    const etudiantsResult = await client.query(
      `SELECT e.id, e.matricule_iipea, e.nom, e.prenoms, e.telephone, e.email, e.photo_url, e.groupe_id
       FROM etudiant e JOIN groupe g ON g.id = e.groupe_id
       WHERE g.classe_id = $1
       ORDER BY e.nom, e.prenoms`,
      [classeId]
    );

    const etudiantsParGroupe = new Map();
    for (const e of etudiantsResult.rows) {
      if (!etudiantsParGroupe.has(e.groupe_id)) etudiantsParGroupe.set(e.groupe_id, []);
      etudiantsParGroupe.get(e.groupe_id).push({
        id: e.id,
        matricule_iipea: e.matricule_iipea,
        nom: e.nom,
        prenoms: e.prenoms,
        telephone: e.telephone,
        email: e.email,
        photo_url: e.photo_url,
      });
    }

    const etudiantsPrimaire = etudiantsParGroupe.get(primaire.id) || [];
    const groupesPedagogiques = groupesResult.rows
      .filter((g) => !g.est_primaire)
      .map((g) => {
        const etudiants = etudiantsParGroupe.get(g.id) || [];
        return {
          id: g.id,
          nom: g.nom,
          capacite_max: g.capacite_max,
          effectif: etudiants.length,
          taux_remplissage: g.capacite_max ? Math.round((etudiants.length / g.capacite_max) * 100) : 0,
          etudiants,
        };
      });

    res.status(200).json({
      success: true,
      data: {
        ...classeResult.rows[0],
        effectif_total: etudiantsResult.rows.length,
        groupe_primaire: { id: primaire.id, effectif: etudiantsPrimaire.length, etudiants: etudiantsPrimaire },
        groupes_pedagogiques: groupesPedagogiques,
      },
    });
  } catch (error) {
    console.error('Erreur détail classe (gestion des groupes):', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// POST /classes/:classeId/groupes — création d'UN groupe pédagogique, répétable. Distinct de
// decouperClasseEnGroupes (bulk, un seul appel, avec distribution automatique) : aucune
// distribution ici, voir deplacerEtudiantsHandler pour le déplacement, acte séparé.
exports.creerGroupePedagogiqueHandler = async (req, res) => {
  const client = await db.connect();
  try {
    const classeId = parseInt(req.params.classeId, 10);
    const { nom, capacite_max } = req.body;
    if (!Number.isInteger(classeId)) {
      return res.status(400).json({ success: false, message: 'Identifiant de classe invalide.' });
    }

    await client.query('BEGIN');
    const groupe = await creerGroupePedagogique(client, { classeId, nom, capaciteMax: capacite_max });
    await client.query('COMMIT');

    res.status(201).json({ success: true, data: groupe });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur création groupe pédagogique:', error);
    res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// PUT /classes/:classeId/groupes/:groupeId — modifie le nom et/ou la capacité d'un groupe
// pédagogique existant. Le Groupe primaire est protégé au niveau du service.
exports.modifierGroupePedagogiqueHandler = async (req, res) => {
  const client = await db.connect();
  try {
    const classeId = parseInt(req.params.classeId, 10);
    const groupeId = parseInt(req.params.groupeId, 10);
    const { nom, capacite_max } = req.body;
    if (!Number.isInteger(classeId) || !Number.isInteger(groupeId)) {
      return res.status(400).json({ success: false, message: 'Identifiant invalide.' });
    }

    await client.query('BEGIN');
    const groupe = await modifierGroupePedagogique(client, { classeId, groupeId, nom, capaciteMax: capacite_max });
    await client.query('COMMIT');

    res.status(200).json({ success: true, data: groupe });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur modification groupe pédagogique:', error);
    res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// DELETE /classes/:classeId/groupes/:groupeId — supprime un groupe pédagogique vide.
exports.supprimerGroupePedagogiqueHandler = async (req, res) => {
  const client = await db.connect();
  try {
    const classeId = parseInt(req.params.classeId, 10);
    const groupeId = parseInt(req.params.groupeId, 10);
    if (!Number.isInteger(classeId) || !Number.isInteger(groupeId)) {
      return res.status(400).json({ success: false, message: 'Identifiant invalide.' });
    }

    await client.query('BEGIN');
    const resultat = await supprimerGroupePedagogique(client, { classeId, groupeId });
    await client.query('COMMIT');

    res.status(200).json({ success: true, data: resultat });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur suppression groupe pédagogique:', error);
    res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// POST /classes/:classeId/groupes/:groupeId/etudiants — déplace des étudiants sélectionnés
// (Groupe primaire -> groupe réel, ou groupe réel -> groupe réel) vers :groupeId. body:
// { etudiantIds: [...] }. Le groupe primaire n'est jamais une destination valide (voir le service).
exports.deplacerEtudiantsHandler = async (req, res) => {
  const client = await db.connect();
  try {
    const classeId = parseInt(req.params.classeId, 10);
    const groupeId = parseInt(req.params.groupeId, 10);
    const { etudiantIds } = req.body;
    if (!Number.isInteger(classeId) || !Number.isInteger(groupeId)) {
      return res.status(400).json({ success: false, message: 'Identifiant invalide.' });
    }

    await client.query('BEGIN');
    const resultat = await deplacerEtudiantsVersGroupe(client, { classeId, groupeDestinationId: groupeId, etudiantIds });
    await client.query('COMMIT');

    res.status(200).json({ success: true, data: resultat });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur déplacement étudiants:', error);
    res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

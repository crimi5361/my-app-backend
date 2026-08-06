// Chantier 10 (2026-08-02) — sous-phases 9 et 10 : distribution des accessoires aux étudiants et
// reçu de remise. Cœur métier du module — cœur de la vigilance anti-fraude (indicateur remis/non
// remis + double blocage : pré-vérification ergonomique ET contrainte UNIQUE en base).
//
// Traçabilité : distribution/ligne_distribution ne stockent QUE des identifiants (etudiant_id,
// accessoire_id, annee_academique_id) — l'enregistrement lui-même ne dépend d'aucune donnée
// mutable et reste donc TOUJOURS accessible (etudiant_id est protégé par une FK sans CASCADE :
// un étudiant ayant déjà reçu ses accessoires ne peut jamais être supprimé, vérifié).
//
// Instantané académique (sous-phase 10) : école/filière/niveau/classe/site SONT en revanche
// supprimables/réaffectables ailleurs dans l'application (ecole/departement/filiere/niveau/site
// ont chacun un endpoint DELETE). Un reçu de remise étant un document officiel, il doit refléter
// la situation de l'étudiant AU MOMENT de la remise, pas sa situation actuelle des années plus
// tard — ces valeurs sont donc figées sur `distribution` à la création, jamais recalculées.
// Seules les données strictement identitaires (nom, matricule, sexe, photo) restent jointes en
// direct depuis `etudiant`, car stables et protégées par la même contrainte FK.
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { enregistrerMouvementStock, getEmplacementStockPourSite } = require('../services/stockMoyensGeneraux.service');

function validerLignes(lignes) {
  if (!Array.isArray(lignes) || lignes.length === 0) {
    return 'Sélectionnez au moins un accessoire à remettre.';
  }
  const accessoireIds = [];
  for (const ligne of lignes) {
    if (!Number.isInteger(ligne.accessoire_id)) {
      return 'Chaque ligne doit référencer un accessoire valide.';
    }
    if (!Number.isInteger(ligne.quantite) || ligne.quantite <= 0) {
      return 'Chaque ligne doit avoir une quantité entière et positive.';
    }
    accessoireIds.push(ligne.accessoire_id);
  }
  if (new Set(accessoireIds).size !== accessoireIds.length) {
    return 'Un même accessoire ne peut apparaître qu\'une seule fois — regroupez les quantités sur une seule ligne.';
  }
  return null;
}

async function getDistributionDetail(dbClient, distributionId, siteId) {
  const header = await dbClient.query(
    `SELECT d.id, d.numero_recu, d.date_remise, d.etudiant_id,
       d.ecole_nom, d.filiere_nom, d.niveau_nom, d.classe_nom, d.site_nom,
       e.nom, e.prenoms, e.matricule, e.matricule_iipea, e.sexe, e.photo_url,
       u.id AS agent_id, u.nom AS agent_nom,
       aa.id AS annee_academique_id, aa.annee AS annee_academique
     FROM distribution d
     JOIN etudiant e ON e.id = d.etudiant_id
     JOIN utilisateur u ON u.id = d.agent_id
     JOIN anneeacademique aa ON aa.id = d.annee_academique_id
     JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
     WHERE d.id = $1 AND es.site_id = $2`,
    [distributionId, siteId]
  );
  if (header.rows.length === 0) return null;

  const lignes = await dbClient.query(
    `SELECT ld.accessoire_id, a.code, a.nom, ld.quantite
     FROM ligne_distribution ld JOIN accessoire a ON a.id = ld.accessoire_id
     WHERE ld.distribution_id = $1 ORDER BY a.nom`,
    [distributionId]
  );

  return { ...header.rows[0], lignes: lignes.rows };
}

// Recherche combinée — deux usages distincts dans une seule requête (validé le 2026-08-02) :
// (a) trouver un étudiant pour une NOUVELLE remise (nom/prénoms/matricule IIPEA) ;
// (b) retrouver une remise DÉJÀ effectuée pour consultation/réimpression (numéro de reçu).
//
// Correctif du 2026-08-03 : (a) est désormais borné à l'année académique sélectionnée, exactement
// comme Scolarité/Comptabilité/Caisse. etudiant.annee_academique_id reflète l'inscription ACTIVE
// de l'étudiant (mise à jour à chaque réinscription, vérifié par introspection : 7205 étudiants
// encore à l'année 2025-2026 faute de réinscription, seulement 11 déjà réinscrits en 2026-2027) —
// un étudiant non réinscrit pour l'année sélectionnée ne doit donc plus apparaître ici. (b) reste
// volontairement NON filtrée par année : un numéro de reçu est un identifiant permanent, un agent
// doit pouvoir retrouver/réimprimer un ancien reçu même en travaillant sur l'année en cours.
exports.rechercher = async (req, res) => {
  try {
    const { q, anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }
    const terme = `%${q.trim()}%`;

    const ecoleCondEtudiant = ecoleId !== null ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $4)' : '';
    const etudiantParams = ecoleId !== null ? [siteId, anneeAcademiqueId, terme, ecoleId] : [siteId, anneeAcademiqueId, terme];

    const etudiantsResult = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.standing, e.photo_url
       FROM etudiant e JOIN filiere f ON f.id = e.id_filiere
       WHERE e.site_id = $1 AND e.annee_academique_id = $2 AND e.standing = 'Inscrit'
         AND (e.nom ILIKE $3 OR e.prenoms ILIKE $3 OR e.matricule_iipea ILIKE $3 OR (e.nom || ' ' || e.prenoms) ILIKE $3)
         ${ecoleCondEtudiant}
       ORDER BY e.nom, e.prenoms LIMIT 20`,
      etudiantParams
    );

    const ecoleCondDistribution = ecoleId !== null
      ? 'AND d.etudiant_id IN (SELECT ex.id FROM etudiant ex WHERE ex.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $3))'
      : '';
    const distributionParams = ecoleId !== null ? [siteId, terme, ecoleId] : [siteId, terme];

    const distributionsResult = await db.query(
      `SELECT d.id, d.numero_recu, d.date_remise, e.id AS etudiant_id, e.nom, e.prenoms, e.matricule_iipea
       FROM distribution d
       JOIN etudiant e ON e.id = d.etudiant_id
       JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
       WHERE es.site_id = $1 AND d.numero_recu ILIKE $2 ${ecoleCondDistribution}
       ORDER BY d.date_remise DESC LIMIT 20`,
      distributionParams
    );

    res.status(200).json({
      success: true,
      data: { etudiants: etudiantsResult.rows, distributions: distributionsResult.rows },
    });
  } catch (error) {
    console.error('Erreur rechercher (distribution):', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Correctif du 2026-08-03 : anneeAcademiqueId est désormais un paramètre obligatoire, pas déduit
// implicitement. La fiche n'est renvoyée que si l'étudiant est réellement inscrit ('Inscrit') pour
// CETTE année précise — un étudiant seulement inscrit une autre année (ex. 2025-2026, non
// réinscrit) est traité comme introuvable, cohérent avec le reste de l'écran de recherche.
exports.getFicheEtudiant = async (req, res) => {
  try {
    const { id } = req.params;
    const { anneeAcademiqueId } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis." });
    }

    const ecoleCond = ecoleId !== null ? 'AND dep.ecole_id = $4' : '';
    const params = ecoleId !== null ? [id, siteId, anneeAcademiqueId, ecoleId] : [id, siteId, anneeAcademiqueId];

    const etudiantResult = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule, e.matricule_iipea, e.sexe, e.photo_url,
         e.standing, e.statut_scolaire, e.annee_academique_id,
         aa.annee AS annee_academique,
         f.nom AS filiere, n.libelle AS niveau, c.nom AS classe,
         ec.nom AS ecole, dep.nom AS departement
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN departement dep ON dep.id = f.departement_id
       JOIN ecole ec ON ec.id = dep.ecole_id
       JOIN niveau n ON n.id = e.niveau_id
       JOIN anneeacademique aa ON aa.id = e.annee_academique_id
       LEFT JOIN groupe g ON g.id = e.groupe_id
       LEFT JOIN classe c ON c.id = g.classe_id
       WHERE e.id = $1 AND e.site_id = $2 AND e.annee_academique_id = $3 AND e.standing = 'Inscrit' ${ecoleCond}`,
      params
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Étudiant introuvable ou non inscrit pour cette année académique." });
    }
    const etudiant = etudiantResult.rows[0];

    const distributionResult = await db.query(
      'SELECT id FROM distribution WHERE etudiant_id = $1 AND annee_academique_id = $2',
      [etudiant.id, anneeAcademiqueId]
    );

    let remise = null;
    if (distributionResult.rows.length > 0) {
      remise = await getDistributionDetail(db, distributionResult.rows[0].id, siteId);
    }

    res.status(200).json({
      success: true,
      data: { ...etudiant, deja_remis: remise !== null, remise },
    });
  } catch (error) {
    console.error('Erreur getFicheEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getDistributionById = async (req, res) => {
  try {
    const { id } = req.params;
    const siteId = req.user.departement_id;
    const detail = await getDistributionDetail(db, id, siteId);
    if (!detail) {
      return res.status(404).json({ success: false, message: 'Remise introuvable.' });
    }
    res.status(200).json({ success: true, data: detail });
  } catch (error) {
    console.error('Erreur getDistributionById:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Sous-phase 11 — historique des distributions. Toutes les colonnes académiques affichées et
// filtrées (école/filière/niveau) proviennent de l'instantané figé sur `distribution`, jamais des
// tables etudiant/filiere/ecole actuelles — cohérent avec le reçu (sous-phase 10).
exports.getHistorique = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    const whereClauses = ['es.site_id = $1'];
    const params = [siteId];

    // Cloisonnement école (Chantier 3) — porte sur l'affectation ACTUELLE de l'étudiant (qui a
    // le droit de voir cette donnée), indépendant de l'instantané académique affiché (ce qui
    // s'est passé au moment de la remise) : même distinction que partout ailleurs dans le module.
    if (ecoleId !== null) {
      whereClauses.push(`e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $${params.length + 1})`);
      params.push(ecoleId);
    }
    if (req.query.q && req.query.q.trim().length >= 2) {
      const terme = `%${req.query.q.trim()}%`;
      whereClauses.push(`(d.numero_recu ILIKE $${params.length + 1} OR e.matricule_iipea ILIKE $${params.length + 1} OR e.matricule ILIKE $${params.length + 1} OR e.nom ILIKE $${params.length + 1} OR e.prenoms ILIKE $${params.length + 1})`);
      params.push(terme);
    }
    if (req.query.annee_academique_id) {
      whereClauses.push(`d.annee_academique_id = $${params.length + 1}`);
      params.push(parseInt(req.query.annee_academique_id, 10));
    }
    if (req.query.date_debut) {
      whereClauses.push(`d.date_remise >= $${params.length + 1}`);
      params.push(req.query.date_debut);
    }
    if (req.query.date_fin) {
      whereClauses.push(`d.date_remise <= $${params.length + 1}::date + INTERVAL '1 day'`);
      params.push(req.query.date_fin);
    }
    if (req.query.ecole) {
      whereClauses.push(`d.ecole_nom = $${params.length + 1}`);
      params.push(req.query.ecole);
    }
    if (req.query.filiere) {
      whereClauses.push(`d.filiere_nom = $${params.length + 1}`);
      params.push(req.query.filiere);
    }
    if (req.query.niveau) {
      whereClauses.push(`d.niveau_nom = $${params.length + 1}`);
      params.push(req.query.niveau);
    }
    if (req.query.agent_id) {
      whereClauses.push(`d.agent_id = $${params.length + 1}`);
      params.push(parseInt(req.query.agent_id, 10));
    }
    if (req.query.accessoire_id) {
      whereClauses.push(`EXISTS (SELECT 1 FROM ligne_distribution ld WHERE ld.distribution_id = d.id AND ld.accessoire_id = $${params.length + 1})`);
      params.push(parseInt(req.query.accessoire_id, 10));
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const countResult = await db.query(
      `SELECT COUNT(*) FROM distribution d
       JOIN etudiant e ON e.id = d.etudiant_id
       JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
       WHERE ${whereClauses.join(' AND ')}`,
      params
    );

    const dataResult = await db.query(
      `SELECT d.id, d.numero_recu, d.date_remise,
         d.ecole_nom, d.filiere_nom, d.niveau_nom, d.classe_nom,
         e.nom, e.prenoms, e.matricule, e.matricule_iipea,
         u.nom AS agent_nom,
         aa.annee AS annee_academique,
         (SELECT COALESCE(SUM(ld.quantite), 0) FROM ligne_distribution ld WHERE ld.distribution_id = d.id) AS total_accessoires
       FROM distribution d
       JOIN etudiant e ON e.id = d.etudiant_id
       JOIN utilisateur u ON u.id = d.agent_id
       JOIN anneeacademique aa ON aa.id = d.annee_academique_id
       JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY d.date_remise DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.status(200).json({
      success: true,
      data: dataResult.rows.map((r) => ({ ...r, total_accessoires: parseInt(r.total_accessoires, 10) })),
      pagination: { page, limit, total: parseInt(countResult.rows[0].count, 10) },
    });
  } catch (error) {
    console.error('Erreur getHistorique:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Valeurs distinctes réellement utilisées dans les remises de ce site (pas le référentiel
// académique complet) — cohérent avec le principe de l'instantané : un filtre ne doit proposer
// que des valeurs qui ont un sens vis-à-vis de ce qui est affiché.
exports.getFiltresHistorique = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    const ecoleCond = ecoleId !== null
      ? 'AND e.id_filiere IN (SELECT fx.id FROM filiere fx JOIN departement dx ON dx.id = fx.departement_id WHERE dx.ecole_id = $2)'
      : '';
    const params = ecoleId !== null ? [siteId, ecoleId] : [siteId];

    const result = await db.query(
      `SELECT DISTINCT d.ecole_nom, d.filiere_nom, d.niveau_nom
       FROM distribution d
       JOIN etudiant e ON e.id = d.etudiant_id
       JOIN emplacement_stock es ON es.id = d.emplacement_stock_id
       WHERE es.site_id = $1 ${ecoleCond}`,
      params
    );

    res.status(200).json({
      success: true,
      data: {
        ecoles: [...new Set(result.rows.map((r) => r.ecole_nom).filter(Boolean))].sort(),
        filieres: [...new Set(result.rows.map((r) => r.filiere_nom).filter(Boolean))].sort(),
        niveaux: [...new Set(result.rows.map((r) => r.niveau_nom).filter(Boolean))].sort(),
      },
    });
  } catch (error) {
    console.error('Erreur getFiltresHistorique:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Correctif du 2026-08-03 : anneeAcademiqueId est désormais transmis explicitement par le
// frontend (année sélectionnée à l'écran) et vérifié contre l'inscription réelle de l'étudiant —
// impossible de distribuer à un étudiant qui n'est pas 'Inscrit' pour cette année précise, même si
// son id_etudiant est par ailleurs valide (ex. étudiant resté sur 2025-2026, non réinscrit).
exports.creerDistribution = async (req, res) => {
  const client = await db.connect();
  try {
    const { etudiant_id, annee_academique_id: anneeAcademiqueIdBody, lignes } = req.body;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!Number.isInteger(etudiant_id)) {
      return res.status(400).json({ success: false, message: 'Un étudiant est requis.' });
    }
    if (!Number.isInteger(anneeAcademiqueIdBody)) {
      return res.status(400).json({ success: false, message: "L'année académique est requise." });
    }
    const erreurLignes = validerLignes(lignes);
    if (erreurLignes) {
      return res.status(400).json({ success: false, message: erreurLignes });
    }

    await client.query('BEGIN');

    const ecoleCond = ecoleId !== null ? 'AND dep.ecole_id = $4' : '';
    const etudiantParams = ecoleId !== null
      ? [etudiant_id, siteId, anneeAcademiqueIdBody, ecoleId]
      : [etudiant_id, siteId, anneeAcademiqueIdBody];
    // Récupère aussi l'instantané académique (école/filière/niveau/classe) au passage — évite une
    // seconde requête, et garantit que ce qui sera figé sur le reçu correspond exactement à ce qui
    // a été vérifié pour l'autorisation (même lecture, pas de fenêtre de désynchronisation).
    // e.annee_academique_id = $3 AND e.standing = 'Inscrit' : c'est ICI que la règle « inscription
    // valide pour l'année sélectionnée » est réellement appliquée, pas seulement côté recherche —
    // impossible de contourner le filtre de recherche par un appel direct à cette route.
    const etudiantResult = await client.query(
      `SELECT e.id, e.annee_academique_id,
         ec.nom AS ecole_nom, f.nom AS filiere_nom, n.libelle AS niveau_nom, c.nom AS classe_nom
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN departement dep ON dep.id = f.departement_id
       JOIN ecole ec ON ec.id = dep.ecole_id
       JOIN niveau n ON n.id = e.niveau_id
       LEFT JOIN groupe g ON g.id = e.groupe_id
       LEFT JOIN classe c ON c.id = g.classe_id
       WHERE e.id = $1 AND e.site_id = $2 AND e.annee_academique_id = $3 AND e.standing = 'Inscrit' ${ecoleCond}`,
      etudiantParams
    );
    if (etudiantResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: "Étudiant introuvable ou non inscrit pour cette année académique." });
    }
    const { ecole_nom: ecoleNom, filiere_nom: filiereNom, niveau_nom: niveauNom, classe_nom: classeNom } = etudiantResult.rows[0];
    const anneeAcademiqueId = anneeAcademiqueIdBody;

    // Blocage ergonomique explicite (en plus de la contrainte UNIQUE en base, qui reste le
    // filet de sécurité définitif contre toute course entre deux requêtes concurrentes — cf.
    // le handler 23505 plus bas).
    const dejaRemis = await client.query(
      'SELECT numero_recu FROM distribution WHERE etudiant_id = $1 AND annee_academique_id = $2',
      [etudiant_id, anneeAcademiqueId]
    );
    if (dejaRemis.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Cet étudiant a déjà reçu ses accessoires pour cette année académique (reçu ${dejaRemis.rows[0].numero_recu}).`,
      });
    }

    const accessoireIds = lignes.map((l) => l.accessoire_id);
    const accessoiresResult = await client.query(
      'SELECT id FROM accessoire WHERE id = ANY($1::int[]) AND actif = true',
      [accessoireIds]
    );
    if (accessoiresResult.rows.length !== new Set(accessoireIds).size) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Un ou plusieurs accessoires sont introuvables ou désactivés.' });
    }

    const emplacementStockId = await getEmplacementStockPourSite(client, siteId);
    const siteResult = await client.query('SELECT nom FROM site WHERE id = $1', [siteId]);
    const siteNom = siteResult.rows[0]?.nom ?? null;
    const numeroRecu = `REM-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    let distributionId;
    try {
      const distributionResult = await client.query(
        `INSERT INTO distribution (etudiant_id, annee_academique_id, agent_id, emplacement_stock_id, numero_recu,
           ecole_nom, filiere_nom, niveau_nom, classe_nom, site_nom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [etudiant_id, anneeAcademiqueId, req.user.id, emplacementStockId, numeroRecu,
          ecoleNom, filiereNom, niveauNom, classeNom, siteNom]
      );
      distributionId = distributionResult.rows[0].id;
    } catch (erreurUnicite) {
      await client.query('ROLLBACK');
      if (erreurUnicite.code === '23505') {
        return res.status(409).json({ success: false, message: 'Cet étudiant a déjà reçu ses accessoires pour cette année académique.' });
      }
      throw erreurUnicite;
    }

    try {
      for (const ligne of lignes) {
        // SEUL point d'écriture sur le grand-livre — jamais d'INSERT direct sur mouvement_stock.
        await enregistrerMouvementStock(client, {
          accessoireId: ligne.accessoire_id,
          emplacementStockId,
          type: 'distribution',
          quantite: ligne.quantite,
          referenceType: 'distribution',
          referenceId: distributionId,
          effectuePar: req.user.id,
          motif: `Remise à l'étudiant #${etudiant_id} — reçu ${numeroRecu}`,
        });
        await client.query(
          'INSERT INTO ligne_distribution (distribution_id, accessoire_id, quantite) VALUES ($1, $2, $3)',
          [distributionId, ligne.accessoire_id, ligne.quantite]
        );
      }
    } catch (erreurMetier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: erreurMetier.message });
    }

    await client.query('COMMIT');
    const detail = await getDistributionDetail(db, distributionId, siteId);
    res.status(201).json({ success: true, data: detail });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur creerDistribution:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

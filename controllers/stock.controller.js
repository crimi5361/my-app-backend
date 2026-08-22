// Chantier 10 (2026-08-02) — sous-phase 8 : gestion opérationnelle du stock.
//
// Tout ajustement passe exclusivement par enregistrerMouvementStock() (règle explicite du
// 2026-08-02) — ce fichier n'insère jamais directement dans mouvement_stock.
const db = require('../config/db.config');
const { enregistrerMouvementStock, getSoldesStockParEmplacement, getEmplacementStockPourSite, getDetailStockParArticle } = require('../services/stockMoyensGeneraux.service');

// Stock initial / reprise de stock (Chantier Moyens Généraux, Phase 2F, 2026-08-20). Représente
// les articles physiquement déjà présents sur le site au démarrage d'une année académique —
// JAMAIS une acquisition fournisseur. site_id n'est JAMAIS accepté du client (toujours
// req.user.departement_id, même principe que partout ailleurs dans ce module : un agent ne peut
// initialiser que son propre site). Une seule déclaration valide par (site, année, article) —
// contrainte UNIQUE en base (stock_initial_unique_site_annee_accessoire), revérifiée ici pour un
// message d'erreur exploitable plutôt qu'un code SQL brut.
exports.declarerStockInitial = async (req, res) => {
  const client = await db.connect();
  try {
    const { accessoire_id, annee_academique_id, quantite, cout_unitaire, observation } = req.body;
    const siteId = req.user.departement_id;

    if (!Number.isInteger(accessoire_id)) {
      return res.status(400).json({ success: false, message: 'Un accessoire est requis.' });
    }
    if (!Number.isInteger(annee_academique_id)) {
      return res.status(400).json({ success: false, message: "L'année académique est requise." });
    }
    if (!Number.isInteger(quantite) || quantite <= 0) {
      return res.status(400).json({ success: false, message: 'La quantité initiale doit être un entier strictement positif.' });
    }
    let coutUnitaire = null;
    if (cout_unitaire !== undefined && cout_unitaire !== null && cout_unitaire !== '') {
      coutUnitaire = parseFloat(cout_unitaire);
      if (Number.isNaN(coutUnitaire) || coutUnitaire < 0) {
        return res.status(400).json({ success: false, message: 'Le coût unitaire doit être un nombre positif ou nul.' });
      }
    }

    await client.query('BEGIN');

    const accessoireResult = await client.query('SELECT id, actif, cout_unitaire_reference FROM accessoire WHERE id = $1', [accessoire_id]);
    if (accessoireResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Accessoire introuvable.' });
    }
    if (!accessoireResult.rows[0].actif) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Cet accessoire est désactivé.' });
    }

    const anneeResult = await client.query('SELECT id FROM anneeacademique WHERE id = $1', [annee_academique_id]);
    if (anneeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Année académique introuvable.' });
    }

    const dejaDeclare = await client.query(
      'SELECT id FROM stock_initial WHERE site_id = $1 AND annee_academique_id = $2 AND accessoire_id = $3 FOR UPDATE',
      [siteId, annee_academique_id, accessoire_id]
    );
    if (dejaDeclare.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'Un stock initial a déjà été déclaré pour cet article sur cette année académique et ce site — une correction passe par un ajustement d\'inventaire, pas par une nouvelle déclaration.',
      });
    }

    const declaration = await client.query(
      `INSERT INTO stock_initial (site_id, annee_academique_id, accessoire_id, quantite, cout_unitaire_saisi, observation, declare_par)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [siteId, annee_academique_id, accessoire_id, quantite, coutUnitaire, observation?.trim() || null, req.user.id]
    );

    const emplacementStockId = await getEmplacementStockPourSite(client, siteId);
    try {
      await enregistrerMouvementStock(client, {
        accessoireId: accessoire_id,
        emplacementStockId,
        type: 'stock_initial',
        quantite,
        referenceType: 'stock_initial',
        referenceId: declaration.rows[0].id,
        effectuePar: req.user.id,
        motif: `Reprise de stock à l'ouverture de l'année académique #${annee_academique_id}`,
      });
    } catch (erreurMetier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: erreurMetier.message });
    }

    // Complète le prix de référence SEULEMENT s'il n'est pas encore configuré — ne jamais écraser
    // une valeur déjà en place (elle est globale, partagée par tous les sites, cf. audit Phase 2E).
    if (coutUnitaire !== null && accessoireResult.rows[0].cout_unitaire_reference === null) {
      await client.query('UPDATE accessoire SET cout_unitaire_reference = $1, updated_at = now() WHERE id = $2', [coutUnitaire, accessoire_id]);
    }

    await client.query('COMMIT');

    const enrichi = await db.query(
      `SELECT si.id, si.site_id, si.annee_academique_id, aa.annee, si.accessoire_id, a.nom AS accessoire_nom, a.code AS accessoire_code,
         si.quantite, si.cout_unitaire_saisi, si.observation, si.declare_par, u.nom AS declare_par_nom, si.date_declaration
       FROM stock_initial si
       JOIN accessoire a ON a.id = si.accessoire_id
       JOIN anneeacademique aa ON aa.id = si.annee_academique_id
       JOIN utilisateur u ON u.id = si.declare_par
       WHERE si.id = $1`,
      [declaration.rows[0].id]
    );
    res.status(201).json({ success: true, data: enrichi.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Un stock initial a déjà été déclaré pour cet article sur cette année académique et ce site.' });
    }
    console.error('Erreur declarerStockInitial:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// Liste des déclarations de stock initial du site de l'agent — filtrable par année académique,
// pour que l'écran sache quels articles ont déjà une déclaration (et grise/masque le formulaire
// pour eux) sans avoir à le déduire indirectement du grand-livre.
exports.getStockInitial = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const conditions = ['si.site_id = $1'];
    const params = [siteId];
    if (req.query.annee_academique_id) {
      params.push(parseInt(req.query.annee_academique_id, 10));
      conditions.push(`si.annee_academique_id = $${params.length}`);
    }
    const result = await db.query(
      `SELECT si.id, si.site_id, si.annee_academique_id, aa.annee, si.accessoire_id, a.nom AS accessoire_nom, a.code AS accessoire_code,
         si.quantite, si.cout_unitaire_saisi, si.observation, si.declare_par, u.nom AS declare_par_nom, si.date_declaration
       FROM stock_initial si
       JOIN accessoire a ON a.id = si.accessoire_id
       JOIN anneeacademique aa ON aa.id = si.annee_academique_id
       JOIN utilisateur u ON u.id = si.declare_par
       WHERE ${conditions.join(' AND ')}
       ORDER BY aa.annee DESC, a.nom`,
      params
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getStockInitial:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getEtatStock = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const emplacementStockId = await getEmplacementStockPourSite(db, siteId);
    const etat = await getSoldesStockParEmplacement(db, emplacementStockId);
    res.status(200).json({ success: true, data: etat });
  } catch (error) {
    console.error('Erreur getEtatStock:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.creerAjustement = async (req, res) => {
  const client = await db.connect();
  try {
    const { accessoire_id, sens, quantite, motif } = req.body;
    const siteId = req.user.departement_id;

    if (!Number.isInteger(accessoire_id)) {
      return res.status(400).json({ success: false, message: 'Un accessoire est requis.' });
    }
    if (!['positif', 'negatif'].includes(sens)) {
      return res.status(400).json({ success: false, message: "Le sens doit être 'positif' ou 'negatif'." });
    }
    if (!Number.isInteger(quantite) || quantite <= 0) {
      return res.status(400).json({ success: false, message: 'La quantité doit être un entier strictement positif.' });
    }
    // La traçabilité d'un ajustement est explicitement exigée — motif obligatoire, contrairement
    // à l'observation facultative d'une réception (qui a déjà le bon de livraison comme référence).
    if (!motif || !motif.trim()) {
      return res.status(400).json({ success: false, message: 'Un motif est obligatoire pour tout ajustement d\'inventaire.' });
    }

    await client.query('BEGIN');

    const accessoireResult = await client.query('SELECT actif FROM accessoire WHERE id = $1', [accessoire_id]);
    if (accessoireResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Accessoire introuvable.' });
    }
    if (!accessoireResult.rows[0].actif) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Cet accessoire est désactivé.' });
    }

    const emplacementStockId = await getEmplacementStockPourSite(client, siteId);

    // Fondation pour un futur inventaire physique formalisé (demandé explicitement) :
    // reference_type='inventaire' existe déjà dans le schéma (migration 004) ; reference_id reste
    // NULL tant qu'aucune session d'inventaire dédiée n'existe — cette sous-phase prépare le
    // terrain sans construire ce workflow complet, comme convenu.
    let mouvement;
    try {
      mouvement = await enregistrerMouvementStock(client, {
        accessoireId: accessoire_id,
        emplacementStockId,
        type: sens === 'positif' ? 'ajustement_positif' : 'ajustement_negatif',
        quantite,
        referenceType: 'inventaire',
        referenceId: null,
        effectuePar: req.user.id,
        motif: motif.trim(),
      });
    } catch (erreurMetier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: erreurMetier.message });
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: mouvement });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur creerAjustement:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// Agents pouvant apparaître comme "effectué par" sur ce site — pour peupler le filtre côté
// historique des mouvements (pas une liste des mouvements eux-mêmes, juste les agents éligibles).
exports.getAgentsStock = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const result = await db.query(
      `SELECT DISTINCT u.id, u.nom
       FROM utilisateur u JOIN role r ON r.id = u.role_id
       WHERE u.site_id = $1 AND r.nom IN ('moyens_generaux', 'admin')
       ORDER BY u.nom`,
      [siteId]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getAgentsStock:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Tableau de bord Moyens Généraux — refonte 2026-08-20 : détail par article (initial/reçu/
// distribué gratuit/distribué surplus/transféré/restant/valeur) + KPI, reconstruits depuis
// getDetailStockParArticle (grand-livre), jamais un second calcul. Filtres appliqués en mémoire
// (le jeu de données par site reste de taille modeste — quelques dizaines d'articles) plutôt qu'en
// SQL, pour ne pas dupliquer la logique de statut déjà centralisée dans le service.
exports.getDetailArticles = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const emplacementStockId = await getEmplacementStockPourSite(db, siteId);
    let articles = await getDetailStockParArticle(db, emplacementStockId);

    if (req.query.categorie_id) {
      const categorieId = parseInt(req.query.categorie_id, 10);
      articles = articles.filter((a) => a.categorie_id === categorieId);
    }
    if (req.query.accessoire_id) {
      const accessoireId = parseInt(req.query.accessoire_id, 10);
      articles = articles.filter((a) => a.accessoire_id === accessoireId);
    }
    if (req.query.statut && ['normal', 'stock_faible', 'rupture'].includes(req.query.statut)) {
      articles = articles.filter((a) => a.statut === req.query.statut);
    }

    const kpis = {
      nombre_articles: articles.length,
      quantite_totale_stock: articles.reduce((somme, a) => somme + a.restant, 0),
      valeur_totale_stock: Math.round(articles.reduce((somme, a) => somme + (a.valeur_stock ?? 0), 0) * 100) / 100,
      articles_bientot_epuises: articles.filter((a) => a.statut === 'stock_faible').length,
      articles_epuises: articles.filter((a) => a.epuise).length,
      quantite_distribuee_totale: articles.reduce((somme, a) => somme + a.distribue_total, 0),
      quantite_transferee_totale: articles.reduce((somme, a) => somme + a.transfere_sortant, 0),
    };

    res.status(200).json({ success: true, data: { kpis, articles } });
  } catch (error) {
    console.error('Erreur getDetailArticles:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getMouvements = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const emplacementStockId = await getEmplacementStockPourSite(db, siteId);

    const whereClauses = ['m.emplacement_stock_id = $1'];
    const params = [emplacementStockId];

    if (req.query.accessoire_id) {
      whereClauses.push(`m.accessoire_id = $${params.length + 1}`);
      params.push(parseInt(req.query.accessoire_id, 10));
    }
    if (req.query.type) {
      whereClauses.push(`m.type = $${params.length + 1}`);
      params.push(req.query.type);
    }
    if (req.query.agent_id) {
      whereClauses.push(`m.effectue_par = $${params.length + 1}`);
      params.push(parseInt(req.query.agent_id, 10));
    }
    if (req.query.date_debut) {
      whereClauses.push(`m.date_mouvement >= $${params.length + 1}`);
      params.push(req.query.date_debut);
    }
    if (req.query.date_fin) {
      whereClauses.push(`m.date_mouvement <= $${params.length + 1}::date + INTERVAL '1 day'`);
      params.push(req.query.date_fin);
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const countResult = await db.query(
      `SELECT COUNT(*) FROM mouvement_stock m WHERE ${whereClauses.join(' AND ')}`,
      params
    );

    const dataResult = await db.query(
      `SELECT m.id, m.type, m.quantite, m.reference_type, m.reference_id, m.date_mouvement, m.motif,
         a.id AS accessoire_id, a.code, a.nom AS accessoire_nom,
         u.id AS agent_id, u.nom AS agent_nom
       FROM mouvement_stock m
       JOIN accessoire a ON a.id = m.accessoire_id
       JOIN utilisateur u ON u.id = m.effectue_par
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY m.date_mouvement DESC, m.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.status(200).json({
      success: true,
      data: dataResult.rows,
      pagination: { page, limit, total: parseInt(countResult.rows[0].count, 10) },
    });
  } catch (error) {
    console.error('Erreur getMouvements:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

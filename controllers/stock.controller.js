// Chantier 10 (2026-08-02) — sous-phase 8 : gestion opérationnelle du stock.
//
// Tout ajustement passe exclusivement par enregistrerMouvementStock() (règle explicite du
// 2026-08-02) — ce fichier n'insère jamais directement dans mouvement_stock.
const db = require('../config/db.config');
const { enregistrerMouvementStock, getSoldesStockParEmplacement, getEmplacementStockPourSite } = require('../services/stockMoyensGeneraux.service');

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

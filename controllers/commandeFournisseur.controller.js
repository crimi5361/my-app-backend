// Chantier 10 (2026-08-02) — sous-phase 6 : commandes fournisseurs.
//
// Règle capitale (rappelée explicitement par le client) : la création/modification d'une commande
// n'écrit JAMAIS dans mouvement_stock — le grand-livre n'est impacté qu'à la réception (sous-phase
// 7). Ce fichier n'importe volontairement pas services/stockMoyensGeneraux.service.js.
//
// Cloisonnement : uniquement par SITE (req.user.departement_id), pas par école — une commande
// fournisseur n'a aucune chaîne vers une école (contrairement à un étudiant via
// filiere→departement→ecole), exactement comme le stock physique lui-même n'est scopé que par
// site (décision validée en sous-phase 2 : un magasin par site, pas par école).
const db = require('../config/db.config');

// partiellement_recue/receptionnee ne sont JAMAIS des transitions manuelles : ce sont des
// conséquences automatiques des réceptions (sous-phase 7), volontairement absentes de cette table.
const TRANSITIONS_AUTORISEES = {
  brouillon: ['envoyee', 'annulee'],
  envoyee: ['annulee'],
};

const SELECT_LIGNES = `
  SELECT lcf.id, lcf.accessoire_id, a.code, a.nom, lcf.quantite_commandee, lcf.quantite_recue
  FROM ligne_commande_fournisseur lcf
  JOIN accessoire a ON a.id = lcf.accessoire_id
  WHERE lcf.commande_id = $1
  ORDER BY a.nom
`;

async function getCommandeComplete(dbClient, commandeId, siteId) {
  const header = await dbClient.query(
    `SELECT cf.id, cf.statut, cf.date_commande, cf.created_at, cf.updated_at,
       f.id AS fournisseur_id, f.nom AS fournisseur_nom
     FROM commande_fournisseur cf
     JOIN fournisseur f ON f.id = cf.fournisseur_id
     WHERE cf.id = $1 AND cf.site_id = $2`,
    [commandeId, siteId]
  );
  if (header.rows.length === 0) return null;
  const lignes = await dbClient.query(SELECT_LIGNES, [commandeId]);
  return {
    ...header.rows[0],
    lignes: lignes.rows.map((l) => ({
      id: l.id,
      accessoire_id: l.accessoire_id,
      code: l.code,
      nom: l.nom,
      quantite_commandee: l.quantite_commandee,
      quantite_recue: l.quantite_recue,
    })),
  };
}

function validerLignes(lignes) {
  if (!Array.isArray(lignes) || lignes.length === 0) {
    return 'Au moins une ligne (accessoire + quantité) est requise.';
  }
  const accessoireIds = [];
  for (const ligne of lignes) {
    if (!Number.isInteger(ligne.accessoire_id)) {
      return 'Chaque ligne doit référencer un accessoire valide.';
    }
    if (!Number.isInteger(ligne.quantite_commandee) || ligne.quantite_commandee <= 0) {
      return 'Chaque ligne doit avoir une quantité commandée entière et positive.';
    }
    accessoireIds.push(ligne.accessoire_id);
  }
  if (new Set(accessoireIds).size !== accessoireIds.length) {
    return 'Un même accessoire ne peut apparaître qu\'une seule fois dans une commande — regroupez les quantités sur une seule ligne.';
  }
  return null;
}

exports.getCommandes = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const result = await db.query(
      `SELECT cf.id, cf.statut, cf.date_commande, cf.created_at, cf.updated_at,
         f.id AS fournisseur_id, f.nom AS fournisseur_nom,
         COUNT(lcf.id) AS nombre_lignes,
         COALESCE(SUM(lcf.quantite_commandee), 0) AS quantite_totale_commandee,
         COALESCE(SUM(lcf.quantite_recue), 0) AS quantite_totale_recue
       FROM commande_fournisseur cf
       JOIN fournisseur f ON f.id = cf.fournisseur_id
       LEFT JOIN ligne_commande_fournisseur lcf ON lcf.commande_id = cf.id
       WHERE cf.site_id = $1
       GROUP BY cf.id, f.id, f.nom
       ORDER BY cf.created_at DESC`,
      [siteId]
    );
    res.status(200).json({
      success: true,
      data: result.rows.map((r) => ({
        id: r.id,
        statut: r.statut,
        date_commande: r.date_commande,
        created_at: r.created_at,
        updated_at: r.updated_at,
        fournisseur_id: r.fournisseur_id,
        fournisseur_nom: r.fournisseur_nom,
        nombre_lignes: parseInt(r.nombre_lignes, 10),
        quantite_totale_commandee: parseInt(r.quantite_totale_commandee, 10),
        quantite_totale_recue: parseInt(r.quantite_totale_recue, 10),
      })),
    });
  } catch (error) {
    console.error('Erreur getCommandes:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getCommandeById = async (req, res) => {
  try {
    const { id } = req.params;
    const siteId = req.user.departement_id;
    const commande = await getCommandeComplete(db, id, siteId);
    if (!commande) {
      return res.status(404).json({ success: false, message: 'Commande introuvable.' });
    }
    res.status(200).json({ success: true, data: commande });
  } catch (error) {
    console.error('Erreur getCommandeById:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.createCommande = async (req, res) => {
  const client = await db.connect();
  try {
    const { fournisseur_id, date_commande, lignes } = req.body;
    const siteId = req.user.departement_id;

    if (!Number.isInteger(fournisseur_id)) {
      return res.status(400).json({ success: false, message: 'Un fournisseur est requis.' });
    }
    const erreurLignes = validerLignes(lignes);
    if (erreurLignes) {
      return res.status(400).json({ success: false, message: erreurLignes });
    }

    await client.query('BEGIN');

    const fournisseurResult = await client.query('SELECT statut FROM fournisseur WHERE id = $1', [fournisseur_id]);
    if (fournisseurResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Fournisseur introuvable.' });
    }
    if (fournisseurResult.rows[0].statut !== 'actif') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Ce fournisseur est désactivé — impossible de lui passer une nouvelle commande.' });
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

    const commandeResult = await client.query(
      `INSERT INTO commande_fournisseur (fournisseur_id, site_id, statut, date_commande)
       VALUES ($1, $2, 'brouillon', COALESCE($3, CURRENT_DATE))
       RETURNING id`,
      [fournisseur_id, siteId, date_commande || null]
    );
    const commandeId = commandeResult.rows[0].id;

    for (const ligne of lignes) {
      await client.query(
        `INSERT INTO ligne_commande_fournisseur (commande_id, accessoire_id, quantite_commandee)
         VALUES ($1, $2, $3)`,
        [commandeId, ligne.accessoire_id, ligne.quantite_commandee]
      );
    }

    await client.query('COMMIT');
    const commande = await getCommandeComplete(db, commandeId, siteId);
    res.status(201).json({ success: true, data: commande });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur createCommande:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

exports.updateCommande = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { fournisseur_id, date_commande, lignes } = req.body;
    const siteId = req.user.departement_id;

    if (!Number.isInteger(fournisseur_id)) {
      return res.status(400).json({ success: false, message: 'Un fournisseur est requis.' });
    }
    const erreurLignes = validerLignes(lignes);
    if (erreurLignes) {
      return res.status(400).json({ success: false, message: erreurLignes });
    }

    await client.query('BEGIN');

    const existante = await client.query(
      'SELECT statut FROM commande_fournisseur WHERE id = $1 AND site_id = $2 FOR UPDATE',
      [id, siteId]
    );
    if (existante.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Commande introuvable.' });
    }
    if (existante.rows[0].statut !== 'brouillon') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Seule une commande à l\'état "brouillon" peut être modifiée.' });
    }

    const fournisseurResult = await client.query('SELECT statut FROM fournisseur WHERE id = $1', [fournisseur_id]);
    if (fournisseurResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Fournisseur introuvable.' });
    }
    if (fournisseurResult.rows[0].statut !== 'actif') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Ce fournisseur est désactivé.' });
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

    await client.query(
      `UPDATE commande_fournisseur SET fournisseur_id = $1, date_commande = COALESCE($2, date_commande), updated_at = now() WHERE id = $3`,
      [fournisseur_id, date_commande || null, id]
    );
    // Remplacement complet des lignes — plus simple et plus sûr qu'un diff, une commande en
    // brouillon n'a par définition encore aucune réception (quantite_recue = 0 partout).
    await client.query('DELETE FROM ligne_commande_fournisseur WHERE commande_id = $1', [id]);
    for (const ligne of lignes) {
      await client.query(
        `INSERT INTO ligne_commande_fournisseur (commande_id, accessoire_id, quantite_commandee)
         VALUES ($1, $2, $3)`,
        [id, ligne.accessoire_id, ligne.quantite_commandee]
      );
    }

    await client.query('COMMIT');
    const commande = await getCommandeComplete(db, id, siteId);
    res.status(200).json({ success: true, data: commande });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur updateCommande:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

exports.setStatutCommande = async (req, res) => {
  try {
    const { id } = req.params;
    const { statut } = req.body;
    const siteId = req.user.departement_id;

    const actuelle = await db.query('SELECT statut FROM commande_fournisseur WHERE id = $1 AND site_id = $2', [id, siteId]);
    if (actuelle.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Commande introuvable.' });
    }
    const statutActuel = actuelle.rows[0].statut;
    const transitionsPossibles = TRANSITIONS_AUTORISEES[statutActuel] || [];
    if (!transitionsPossibles.includes(statut)) {
      return res.status(409).json({
        success: false,
        message: `Transition impossible : une commande "${statutActuel}" ne peut passer qu'à l'état ${transitionsPossibles.length > 0 ? transitionsPossibles.join(' ou ') : '(aucun changement manuel possible à ce stade)'}.`,
      });
    }

    const result = await db.query(
      'UPDATE commande_fournisseur SET statut = $1, updated_at = now() WHERE id = $2 RETURNING id',
      [statut, id]
    );
    const commande = await getCommandeComplete(db, result.rows[0].id, siteId);
    res.status(200).json({ success: true, data: commande });
  } catch (error) {
    console.error('Erreur setStatutCommande:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

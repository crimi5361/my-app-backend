// Chantier 10 (2026-08-02) — sous-phase 7 : réceptions fournisseurs.
//
// Point d'entrée du grand-livre pour ce module : c'est ICI que mouvement_stock reçoit ses
// premières écritures réelles (type='reception'), exclusivement via
// services/stockMoyensGeneraux.service.js::enregistrerMouvementStock — jamais d'INSERT direct.
//
// Transactionnel de bout en bout (règle explicite du 2026-08-02) : verrous FOR UPDATE sur la
// commande et sur chaque ligne concernée pour empêcher deux réceptions concurrentes de
// dépasser la quantité restante ; un ROLLBACK complet si une seule ligne échoue.
const db = require('../config/db.config');
const { enregistrerMouvementStock, getEmplacementStockPourSite } = require('../services/stockMoyensGeneraux.service');

function validerLignesReception(lignes) {
  if (!Array.isArray(lignes) || lignes.length === 0) {
    return 'Au moins une ligne (accessoire + quantité reçue) est requise.';
  }
  const accessoireIds = [];
  for (const ligne of lignes) {
    if (!Number.isInteger(ligne.accessoire_id)) {
      return 'Chaque ligne doit référencer un accessoire valide.';
    }
    if (!Number.isInteger(ligne.quantite) || ligne.quantite <= 0) {
      return 'Chaque ligne doit avoir une quantité reçue entière et positive.';
    }
    accessoireIds.push(ligne.accessoire_id);
  }
  if (new Set(accessoireIds).size !== accessoireIds.length) {
    return 'Un même accessoire ne peut apparaître qu\'une seule fois dans une réception — regroupez les quantités sur une seule ligne.';
  }
  return null;
}

// Recalcule le statut de la commande à partir de l'état réel des lignes (jamais incrémenté à
// l'aveugle) — cohérent avec le principe du grand-livre : une vérité dérivée, pas stockée à côté.
function calculerStatutCommande(lignes) {
  const toutesCompletes = lignes.every((l) => l.quantite_recue >= l.quantite_commandee);
  if (toutesCompletes) return 'receptionnee';
  const auMoinsUneRecue = lignes.some((l) => l.quantite_recue > 0);
  if (auMoinsUneRecue) return 'partiellement_recue';
  return 'envoyee';
}

exports.creerReception = async (req, res) => {
  const client = await db.connect();
  try {
    const { id: commandeId } = req.params;
    const { date_reception, reference_bl, observation, lignes } = req.body;
    const siteId = req.user.departement_id;

    const erreurLignes = validerLignesReception(lignes);
    if (erreurLignes) {
      return res.status(400).json({ success: false, message: erreurLignes });
    }

    await client.query('BEGIN');

    const commandeResult = await client.query(
      'SELECT id, statut FROM commande_fournisseur WHERE id = $1 AND site_id = $2 FOR UPDATE',
      [commandeId, siteId]
    );
    if (commandeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Commande introuvable.' });
    }
    const statutActuel = commandeResult.rows[0].statut;
    if (!['envoyee', 'partiellement_recue'].includes(statutActuel)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Impossible de réceptionner une commande à l'état "${statutActuel}" — seules les commandes envoyées ou partiellement reçues peuvent l'être.`,
      });
    }

    // Verrouille et vérifie CHAQUE ligne concernée avant toute écriture — si une seule dépasse le
    // restant, on annule tout (aucune écriture partielle).
    const lignesVerifiees = [];
    for (const ligneDemandee of lignes) {
      const ligneResult = await client.query(
        `SELECT id, accessoire_id, quantite_commandee, quantite_recue
         FROM ligne_commande_fournisseur
         WHERE commande_id = $1 AND accessoire_id = $2 FOR UPDATE`,
        [commandeId, ligneDemandee.accessoire_id]
      );
      if (ligneResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `L'accessoire #${ligneDemandee.accessoire_id} ne fait pas partie de cette commande.` });
      }
      const ligne = ligneResult.rows[0];
      const restant = ligne.quantite_commandee - ligne.quantite_recue;
      if (ligneDemandee.quantite > restant) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: `Quantité reçue (${ligneDemandee.quantite}) supérieure à la quantité restant à livrer (${restant}) pour cette ligne.`,
        });
      }
      lignesVerifiees.push({ ligneId: ligne.id, accessoireId: ligne.accessoire_id, quantite: ligneDemandee.quantite });
    }

    const emplacementStockId = await getEmplacementStockPourSite(client, siteId);

    const receptionResult = await client.query(
      `INSERT INTO reception_fournisseur (commande_id, date_reception, recu_par, reference_bl, observation)
       VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5)
       RETURNING id`,
      [commandeId, date_reception || null, req.user.id, reference_bl?.trim() || null, observation?.trim() || null]
    );
    const receptionId = receptionResult.rows[0].id;

    for (const ligne of lignesVerifiees) {
      // SEUL point d'écriture sur le grand-livre — jamais d'INSERT direct sur mouvement_stock ici.
      await enregistrerMouvementStock(client, {
        accessoireId: ligne.accessoireId,
        emplacementStockId,
        type: 'reception',
        quantite: ligne.quantite,
        referenceType: 'reception_fournisseur',
        referenceId: receptionId,
        effectuePar: req.user.id,
        motif: reference_bl ? `Réception commande #${commandeId} — BL ${reference_bl}` : `Réception commande #${commandeId}`,
      });
      await client.query(
        'UPDATE ligne_commande_fournisseur SET quantite_recue = quantite_recue + $1 WHERE id = $2',
        [ligne.quantite, ligne.ligneId]
      );
    }

    // Statut recalculé à partir de l'état réel de TOUTES les lignes de la commande (pas
    // seulement celles reçues aujourd'hui) — une ligne jamais livrée bloque le passage à
    // "receptionnee", exactement la règle demandée.
    const toutesLignes = await client.query(
      'SELECT quantite_commandee, quantite_recue FROM ligne_commande_fournisseur WHERE commande_id = $1',
      [commandeId]
    );
    const nouveauStatut = calculerStatutCommande(toutesLignes.rows);
    await client.query(
      'UPDATE commande_fournisseur SET statut = $1, updated_at = now() WHERE id = $2',
      [nouveauStatut, commandeId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: { reception_id: receptionId, commande_id: parseInt(commandeId, 10), nouveau_statut: nouveauStatut },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur creerReception:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

exports.getReceptionsCommande = async (req, res) => {
  try {
    const { id: commandeId } = req.params;
    const siteId = req.user.departement_id;

    const commande = await db.query(
      'SELECT id FROM commande_fournisseur WHERE id = $1 AND site_id = $2',
      [commandeId, siteId]
    );
    if (commande.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Commande introuvable.' });
    }

    const receptions = await db.query(
      `SELECT r.id, r.date_reception, r.reference_bl, r.observation, r.recu_par, u.nom AS recu_par_nom
       FROM reception_fournisseur r
       JOIN utilisateur u ON u.id = r.recu_par
       WHERE r.commande_id = $1
       ORDER BY r.date_reception DESC, r.id DESC`,
      [commandeId]
    );

    // Détail ligne par ligne de chaque réception — reconstitué depuis le grand-livre
    // (mouvement_stock), qui EST déjà le détail de ce qui a été reçu à chaque événement.
    const lignesParReception = await db.query(
      `SELECT m.reference_id AS reception_id, a.nom AS accessoire, a.code, m.quantite
       FROM mouvement_stock m
       JOIN accessoire a ON a.id = m.accessoire_id
       WHERE m.reference_type = 'reception_fournisseur'
         AND m.reference_id = ANY($1::int[])
       ORDER BY a.nom`,
      [receptions.rows.map((r) => r.id)]
    );

    const data = receptions.rows.map((r) => ({
      id: r.id,
      date_reception: r.date_reception,
      reference_bl: r.reference_bl,
      observation: r.observation,
      recu_par: r.recu_par_nom,
      lignes: lignesParReception.rows
        .filter((l) => l.reception_id === r.id)
        .map((l) => ({ accessoire: l.accessoire, code: l.code, quantite: l.quantite })),
    }));

    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Erreur getReceptionsCommande:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

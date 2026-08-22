// Chantier Moyens Généraux — Phase 2E (2026-08-19) : transferts d'accessoires entre sites.
//
// Cycle de vie : BROUILLON (créé, aucun effet sur le stock) → ENVOYE (stock source décrémenté,
// SEULEMENT à ce moment) → RECEPTIONNE (stock destination incrémenté, état terminal) → ANNULE
// (uniquement possible depuis BROUILLON — après expédition, aucun mécanisme de retour/reversal
// n'est inventé, cf. audit). Réutilise entièrement enregistrerMouvementStock (verrou FOR UPDATE,
// grand-livre append-only) — aucune écriture directe sur mouvement_stock dans ce fichier.
const db = require('../config/db.config');
const { enregistrerMouvementStock, getEmplacementStockPourSite } = require('../services/stockMoyensGeneraux.service');
const { avecRetryCodeUnique } = require('../services/codePaiement.service');

const SELECT_ENRICHI = `SELECT
    t.id, t.reference, t.quantite_demandee, t.quantite_receptionnee, t.statut,
    t.accessoire_id, a.nom AS accessoire_nom, a.code AS accessoire_code,
    t.site_source_id, ss.nom AS site_source_nom,
    t.site_destination_id, sd.nom AS site_destination_nom,
    t.cree_par, ucr.nom AS cree_par_nom,
    t.envoye_par, uen.nom AS envoye_par_nom,
    t.receptionne_par, ure.nom AS receptionne_par_nom,
    t.annule_par, uan.nom AS annule_par_nom,
    t.motif_annulation, t.observation_reception,
    t.date_creation, t.date_envoi, t.date_reception, t.date_annulation
  FROM transfert_stock t
  JOIN accessoire a ON a.id = t.accessoire_id
  JOIN site ss ON ss.id = t.site_source_id
  JOIN site sd ON sd.id = t.site_destination_id
  JOIN utilisateur ucr ON ucr.id = t.cree_par
  LEFT JOIN utilisateur uen ON uen.id = t.envoye_par
  LEFT JOIN utilisateur ure ON ure.id = t.receptionne_par
  LEFT JOIN utilisateur uan ON uan.id = t.annule_par`;

// Un transfert peut toujours être créé depuis n'importe quel accessoire actif — jamais restreint
// à distribuable_etudiant=true (un transfert est un mouvement de stock interne entre sites, pas une
// distribution à un étudiant ; ex. du papier A4 peut légitimement être transféré).
async function validerAccessoireActif(accessoireId) {
  const id = parseInt(accessoireId, 10);
  if (Number.isNaN(id)) return { ok: false, message: 'Accessoire invalide.' };
  const result = await db.query('SELECT id, actif FROM accessoire WHERE id = $1', [id]);
  if (result.rows.length === 0) return { ok: false, message: 'Accessoire introuvable.' };
  if (!result.rows[0].actif) return { ok: false, message: 'Cet accessoire est désactivé.' };
  return { ok: true, valeur: id };
}

// Site "non opérationnel" (ajustement transitoire, 2026-08-20) : tant qu'un site n'a pas encore
// d'agent Moyens Généraux actif sur la plateforme (aujourd'hui, seul COCODY est opérationnel), le
// site qui a initié un transfert vers lui peut déclarer la réception à sa place — cf.
// receptionnerTransfert ci-dessous. Configuré par site via une variable d'env, sur le même patron
// que KIT_ANNEES_SUSPENDUES (services/kitCampagne.service.js) : liste explicite, réversible site
// par site dès qu'un agent y est actif, jamais un bypass de rôle ni un bypass global.
// MG_SITES_NON_OPERATIONNELS="2,3" — vide/absent = comportement strict inchangé (seul le site
// destinataire peut réceptionner ses propres transferts).
function siteEstNonOperationnel(siteId) {
  return (process.env.MG_SITES_NON_OPERATIONNELS || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n))
    .includes(siteId);
}

// Expose au frontend si L'AGENT APPELANT peut déclarer la réception de CE transfert précis —
// correctif 2026-08-20 : Transferts.tsx ne pouvait auparavant afficher le bouton "Réceptionner" que
// si site_destination_id === son propre site, ce qui rendait la dérogation ci-dessus (COCODY
// réceptionnant pour un site non opérationnel) invisible et donc inutilisable depuis l'écran, même
// si l'API l'acceptait déjà. Recalcule exactement la même condition que receptionnerTransfert,
// jamais une nouvelle règle parallèle — le backend revalide de toute façon à l'appel réel.
function enrichirAvecPermissionReception(transfert, siteId) {
  return {
    ...transfert,
    peut_receptionner_ici: transfert.statut === 'ENVOYE' && (
      transfert.site_destination_id === siteId
      || (transfert.site_source_id === siteId && siteEstNonOperationnel(transfert.site_destination_id))
    ),
  };
}

async function validerSiteDestination(siteDestinationId, siteSourceId) {
  const id = parseInt(siteDestinationId, 10);
  if (Number.isNaN(id)) return { ok: false, message: 'Site destinataire invalide.' };
  if (id === siteSourceId) return { ok: false, message: 'Le site destinataire doit être différent du site expéditeur.' };
  const result = await db.query('SELECT id FROM site WHERE id = $1', [id]);
  if (result.rows.length === 0) return { ok: false, message: 'Site destinataire introuvable.' };
  return { ok: true, valeur: id };
}

// Création : toujours en BROUILLON, aucun effet sur le stock. site_source_id n'est JAMAIS accepté
// depuis le client — c'est TOUJOURS le site de l'agent connecté (§ "vérifier que l'accessoire
// appartient bien au stock du site expéditeur" : un agent ne peut initier un transfert que depuis
// son propre site, jamais en se faisant passer pour un autre).
exports.creerTransfert = async (req, res) => {
  try {
    const { accessoire_id, quantite_demandee, site_destination_id } = req.body;
    const siteSourceId = req.user.departement_id;

    if (!Number.isInteger(quantite_demandee) || quantite_demandee <= 0) {
      return res.status(400).json({ success: false, message: 'La quantité demandée doit être un entier strictement positif.' });
    }
    const accessoire = await validerAccessoireActif(accessoire_id);
    if (!accessoire.ok) return res.status(400).json({ success: false, message: accessoire.message });
    const siteDestination = await validerSiteDestination(site_destination_id, siteSourceId);
    if (!siteDestination.ok) return res.status(400).json({ success: false, message: siteDestination.message });

    const inserted = await avecRetryCodeUnique('TRANSFERT', (reference) => db.query(
      `INSERT INTO transfert_stock
         (reference, accessoire_id, site_source_id, site_destination_id, quantite_demandee, statut, cree_par)
       VALUES ($1, $2, $3, $4, $5, 'BROUILLON', $6)
       RETURNING id`,
      [reference, accessoire.valeur, siteSourceId, siteDestination.valeur, quantite_demandee, req.user.id]
    ));

    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE t.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ success: true, data: enrichirAvecPermissionReception(enrichi.rows[0], siteSourceId) });
  } catch (error) {
    console.error('Erreur creerTransfert:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Liste : un transfert concerne TOUJOURS deux sites — par défaut, montre tout ce qui touche le
// site de l'agent (envoyé PAR lui OU destiné À lui), jamais restreint à un seul sens implicitement.
exports.getTransferts = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const direction = req.query.direction || 'tous';

    const conditions = [];
    const params = [];
    if (direction === 'envoyes') {
      params.push(siteId);
      conditions.push(`t.site_source_id = $${params.length}`);
    } else if (direction === 'recus') {
      params.push(siteId);
      conditions.push(`t.site_destination_id = $${params.length}`);
    } else {
      params.push(siteId);
      conditions.push(`(t.site_source_id = $${params.length} OR t.site_destination_id = $${params.length})`);
    }
    if (req.query.statut) {
      params.push(req.query.statut);
      conditions.push(`t.statut = $${params.length}`);
    }
    if (req.query.accessoire_id) {
      params.push(parseInt(req.query.accessoire_id, 10));
      conditions.push(`t.accessoire_id = $${params.length}`);
    }
    if (req.query.date_debut) {
      params.push(req.query.date_debut);
      conditions.push(`t.date_creation >= $${params.length}`);
    }
    if (req.query.date_fin) {
      params.push(req.query.date_fin);
      conditions.push(`t.date_creation <= $${params.length}::date + INTERVAL '1 day'`);
    }

    const result = await db.query(
      `${SELECT_ENRICHI} WHERE ${conditions.join(' AND ')} ORDER BY t.date_creation DESC`,
      params
    );
    res.status(200).json({ success: true, data: result.rows.map((row) => enrichirAvecPermissionReception(row, siteId)) });
  } catch (error) {
    console.error('Erreur getTransferts:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getTransfertById = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const result = await db.query(`${SELECT_ENRICHI} WHERE t.id = $1`, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
    }
    const transfert = result.rows[0];
    if (transfert.site_source_id !== siteId && transfert.site_destination_id !== siteId) {
      return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
    }
    res.status(200).json({ success: true, data: enrichirAvecPermissionReception(transfert, siteId) });
  } catch (error) {
    console.error('Erreur getTransfertById:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Annulation : uniquement depuis BROUILLON — aucun mouvement de stock n'a encore eu lieu, donc rien
// à réconcilier. Une fois ENVOYE, une annulation nécessiterait un mécanisme de retour non demandé
// et non implémenté ici (cf. audit, même principe que le remboursement en Phase 2D).
exports.annulerTransfert = async (req, res) => {
  try {
    const { id } = req.params;
    const { motif } = req.body;
    const siteId = req.user.departement_id;
    if (!motif || !motif.trim()) {
      return res.status(400).json({ success: false, message: 'Un motif est obligatoire pour annuler un transfert.' });
    }
    const transfertResult = await db.query('SELECT statut, site_source_id FROM transfert_stock WHERE id = $1', [id]);
    if (transfertResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
    }
    const transfert = transfertResult.rows[0];
    if (transfert.site_source_id !== siteId) {
      return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
    }
    if (transfert.statut !== 'BROUILLON') {
      return res.status(409).json({
        success: false,
        message: `Seul un transfert en brouillon peut être annulé (statut actuel : ${transfert.statut}).`,
      });
    }
    const result = await db.query(
      `UPDATE transfert_stock SET statut = 'ANNULE', motif_annulation = $1, annule_par = $2, date_annulation = now() WHERE id = $3 RETURNING id`,
      [motif.trim(), req.user.id, id]
    );
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE t.id = $1`, [result.rows[0].id]);
    res.status(200).json({ success: true, data: enrichirAvecPermissionReception(enrichi.rows[0], siteId) });
  } catch (error) {
    console.error('Erreur annulerTransfert:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Envoi : BROUILLON → ENVOYE. SEUL moment où le stock du site source est décrémenté. Verrou
// FOR UPDATE + vérification de solde posés dans enregistrerMouvementStock (Phase 2C) — filet de
// sécurité définitif contre toute course concurrente sur le dernier exemplaire.
exports.envoyerTransfert = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const siteId = req.user.departement_id;

    await client.query('BEGIN');

    const transfertResult = await client.query('SELECT * FROM transfert_stock WHERE id = $1 FOR UPDATE', [id]);
    if (transfertResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
    }
    const transfert = transfertResult.rows[0];
    if (transfert.site_source_id !== siteId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
    }
    if (transfert.statut !== 'BROUILLON') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Ce transfert ne peut pas être envoyé (statut actuel : ${transfert.statut}).`,
      });
    }

    const emplacementSourceId = await getEmplacementStockPourSite(client, transfert.site_source_id);

    try {
      await enregistrerMouvementStock(client, {
        accessoireId: transfert.accessoire_id,
        emplacementStockId: emplacementSourceId,
        type: 'transfert_sortant',
        quantite: transfert.quantite_demandee,
        referenceType: 'transfert_stock',
        referenceId: transfert.id,
        effectuePar: req.user.id,
        motif: `Transfert ${transfert.reference} vers le site destinataire`,
      });
    } catch (erreurMetier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: erreurMetier.message });
    }

    await client.query(
      `UPDATE transfert_stock SET statut = 'ENVOYE', envoye_par = $1, date_envoi = now() WHERE id = $2`,
      [req.user.id, id]
    );

    await client.query('COMMIT');
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE t.id = $1`, [id]);
    res.status(200).json({ success: true, data: enrichirAvecPermissionReception(enrichi.rows[0], siteId) });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur envoyerTransfert:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// Réception : ENVOYE → RECEPTIONNE (terminal). SEUL moment où le stock du site destinataire
// augmente — crédité sur l'emplacement du site DESTINATAIRE (ligne emplacementDestinationId
// ci-dessous), quel que soit l'agent qui appelle cet endpoint : la dérogation transitoire
// ci-dessous ne change jamais QUEL stock est crédité, seulement QUI est autorisé à déclarer la
// réception. Normalement effectuée par le site destinataire ; par dérogation transitoire (voir
// siteEstNonOperationnel), le site expéditeur peut aussi la déclarer si le site destinataire n'a
// pas encore d'agent actif. quantite_receptionnee peut différer de quantite_demandee (ex. casse en
// transit) ; par défaut, égale à la quantité demandée si non précisée.
exports.receptionnerTransfert = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { quantite_receptionnee, observation } = req.body;
    const siteId = req.user.departement_id;

    await client.query('BEGIN');

    const transfertResult = await client.query('SELECT * FROM transfert_stock WHERE id = $1 FOR UPDATE', [id]);
    if (transfertResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
    }
    const transfert = transfertResult.rows[0];
    const receptionParSiteSource = siteId === transfert.site_source_id
      && siteEstNonOperationnel(transfert.site_destination_id);
    if (transfert.site_destination_id !== siteId && !receptionParSiteSource) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
    }
    if (transfert.statut === 'RECEPTIONNE') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Ce transfert a déjà été réceptionné.' });
    }
    if (transfert.statut !== 'ENVOYE') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Ce transfert ne peut pas être réceptionné (statut actuel : ${transfert.statut}).`,
      });
    }

    const quantiteRecue = Number.isInteger(quantite_receptionnee) && quantite_receptionnee > 0
      ? quantite_receptionnee
      : transfert.quantite_demandee;

    const emplacementDestinationId = await getEmplacementStockPourSite(client, transfert.site_destination_id);

    try {
      await enregistrerMouvementStock(client, {
        accessoireId: transfert.accessoire_id,
        emplacementStockId: emplacementDestinationId,
        type: 'transfert_entrant',
        quantite: quantiteRecue,
        referenceType: 'transfert_stock',
        referenceId: transfert.id,
        effectuePar: req.user.id,
        motif: `Transfert ${transfert.reference} reçu du site expéditeur`,
      });
    } catch (erreurMetier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: erreurMetier.message });
    }

    // Traçabilité de la dérogation (§ receptionParSiteSource ci-dessus) : si l'agent n'a pas déjà
    // renseigné sa propre observation, on note explicitement que la réception a été déclarée par
    // le site expéditeur — jamais silencieux, pour qu'une relecture ultérieure de l'historique
    // comprenne pourquoi receptionne_par appartient au site source plutôt qu'au site destinataire.
    const observationFinale = observation?.trim()
      || (receptionParSiteSource
        ? `Réceptionné par l'agent du site expéditeur — le site destinataire n'a pas encore d'agent actif sur la plateforme.`
        : null);

    await client.query(
      `UPDATE transfert_stock
       SET statut = 'RECEPTIONNE', receptionne_par = $1, date_reception = now(),
           quantite_receptionnee = $2, observation_reception = $3
       WHERE id = $4`,
      [req.user.id, quantiteRecue, observationFinale, id]
    );

    await client.query('COMMIT');
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE t.id = $1`, [id]);
    res.status(200).json({ success: true, data: enrichirAvecPermissionReception(enrichi.rows[0], siteId) });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur receptionnerTransfert:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

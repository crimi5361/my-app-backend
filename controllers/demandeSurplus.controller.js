// Chantier Moyens Généraux — Phase 2D (2026-08-19) : accessoires supplémentaires payants.
//
// Workflow obligatoire (§1) : Étudiant → Moyens Généraux crée la demande (CE FICHIER, creerDemande)
// → Caisse encaisse (controllers/caisse.controller.js::encaisserSurplus, JAMAIS ici) → paiement
// confirmé → distribution autorisée → stock décrémenté (CE FICHIER, distribuerSurplus). La création
// d'une demande n'écrit JAMAIS dans `paiement`, ne touche JAMAIS `scolarite`, ne touche JAMAIS le
// stock et ne crée JAMAIS de `distribution` — uniquement au moment de distribuerSurplus, et
// seulement si la demande est PAYE.
const db = require('../config/db.config');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');
const { enregistrerMouvementStock, getEmplacementStockPourSite } = require('../services/stockMoyensGeneraux.service');
const { avecRetryCodeUnique } = require('../services/codePaiement.service');

const SELECT_ENRICHI = `SELECT
    d.id, d.reference, d.quantite, d.prix_unitaire_vente, d.montant_total, d.statut,
    d.date_demande, d.date_paiement, d.date_distribution, d.date_annulation, d.motif_annulation,
    d.etudiant_id, e.nom AS etudiant_nom, e.prenoms AS etudiant_prenoms, e.matricule_iipea,
    d.accessoire_id, a.nom AS accessoire_nom, a.code AS accessoire_code,
    a.cout_unitaire_reference AS accessoire_prix_achat_actuel,
    d.annee_academique_id, aa.annee AS annee_academique,
    d.demande_par, udp.nom AS demande_par_nom,
    d.paiement_id, r.numero_recu AS paiement_numero_recu, p.methode AS paiement_methode,
    d.distribution_id, dist.numero_recu AS distribution_numero_recu,
    d.distribue_par, udi.nom AS distribue_par_nom,
    d.annule_par, uda.nom AS annule_par_nom
  FROM demande_surplus_accessoire d
  JOIN etudiant e ON e.id = d.etudiant_id
  JOIN accessoire a ON a.id = d.accessoire_id
  JOIN anneeacademique aa ON aa.id = d.annee_academique_id
  JOIN utilisateur udp ON udp.id = d.demande_par
  LEFT JOIN paiement p ON p.id = d.paiement_id
  LEFT JOIN recu r ON r.id = p.recu_id
  LEFT JOIN distribution dist ON dist.id = d.distribution_id
  LEFT JOIN utilisateur udi ON udi.id = d.distribue_par
  LEFT JOIN utilisateur uda ON uda.id = d.annule_par`;

exports.creerDemande = async (req, res) => {
  try {
    const { etudiant_id, accessoire_id, quantite, annee_academique_id } = req.body;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    if (!Number.isInteger(etudiant_id)) {
      return res.status(400).json({ success: false, message: 'Un étudiant est requis.' });
    }
    if (!Number.isInteger(accessoire_id)) {
      return res.status(400).json({ success: false, message: 'Un accessoire est requis.' });
    }
    if (!Number.isInteger(quantite) || quantite <= 0) {
      return res.status(400).json({ success: false, message: 'La quantité doit être un entier strictement positif.' });
    }
    if (!Number.isInteger(annee_academique_id)) {
      return res.status(400).json({ success: false, message: "L'année académique est requise." });
    }

    // Même garde que distribution.controller.js::creerDistribution — un étudiant inexistant ou
    // non inscrit pour cette année précise ne peut faire l'objet d'aucune demande.
    const ecoleCond = ecoleId !== null ? 'AND dep.ecole_id = $4' : '';
    const etudiantParams = ecoleId !== null
      ? [etudiant_id, siteId, annee_academique_id, ecoleId]
      : [etudiant_id, siteId, annee_academique_id];
    const etudiantResult = await db.query(
      `SELECT e.id FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN departement dep ON dep.id = f.departement_id
       WHERE e.id = $1 AND e.site_id = $2 AND e.annee_academique_id = $3 AND e.standing = 'Inscrit' ${ecoleCond}`,
      etudiantParams
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Étudiant introuvable ou non inscrit pour cette année académique." });
    }

    const accessoireResult = await db.query(
      'SELECT id, distribuable_etudiant, actif, prix_vente_surplus FROM accessoire WHERE id = $1',
      [accessoire_id]
    );
    if (accessoireResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Accessoire introuvable.' });
    }
    const accessoire = accessoireResult.rows[0];
    if (!accessoire.actif) {
      return res.status(400).json({ success: false, message: 'Cet accessoire est désactivé.' });
    }
    if (!accessoire.distribuable_etudiant) {
      return res.status(400).json({ success: false, message: "Cet accessoire n'est pas distribuable aux étudiants." });
    }
    // §6 (ajustements Phase 2D) : le prix de vente surplus est une notion distincte du coût
    // d'achat (accessoire.cout_unitaire_reference) — configuré séparément par l'agent, jamais
    // déduit du prix d'achat.
    if (accessoire.prix_vente_surplus === null) {
      return res.status(400).json({
        success: false,
        message: "Cet accessoire n'a pas de prix de vente surplus configuré — impossible de calculer un montant à faire payer.",
      });
    }

    // Prix figé DÉFINITIVEMENT au moment de la demande (§6) — jamais recalculé, même si le prix
    // de vente surplus du catalogue change ensuite. montant_total calculé ici, jamais côté client.
    const prixUnitaireVente = parseFloat(accessoire.prix_vente_surplus);
    const montantTotal = Math.round(prixUnitaireVente * quantite * 100) / 100;

    const inserted = await avecRetryCodeUnique('SURPLUS', (reference) => db.query(
      `INSERT INTO demande_surplus_accessoire
         (reference, etudiant_id, accessoire_id, quantite, prix_unitaire_vente, montant_total, annee_academique_id, statut, demande_par)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'EN_ATTENTE_PAIEMENT', $8)
       RETURNING id`,
      [reference, etudiant_id, accessoire_id, quantite, prixUnitaireVente, montantTotal, annee_academique_id, req.user.id]
    ));

    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE d.id = $1`, [inserted.rows[0].id]);
    res.status(201).json({ success: true, data: enrichi.rows[0] });
  } catch (error) {
    console.error('Erreur creerDemande:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Cloisonnement par site (correctif 2026-08-20) : une demande de surplus appartient au site de
// l'étudiant concerné (etudiant.site_id) — même principe que distribuerSurplus, qui vérifiait déjà
// demande.site_id !== siteId avant toute distribution, mais que la liste/le détail avaient omis.
exports.getDemandes = async (req, res) => {
  try {
    const conditions = ['e.site_id = $1'];
    const params = [req.user.departement_id];
    if (req.query.statut) {
      params.push(req.query.statut);
      conditions.push(`d.statut = $${params.length}`);
    }
    if (req.query.annee_academique_id) {
      params.push(parseInt(req.query.annee_academique_id, 10));
      conditions.push(`d.annee_academique_id = $${params.length}`);
    }
    if (req.query.etudiant_id) {
      params.push(parseInt(req.query.etudiant_id, 10));
      conditions.push(`d.etudiant_id = $${params.length}`);
    }
    if (req.query.accessoire_id) {
      params.push(parseInt(req.query.accessoire_id, 10));
      conditions.push(`d.accessoire_id = $${params.length}`);
    }
    if (req.query.date_debut) {
      params.push(req.query.date_debut);
      conditions.push(`d.date_demande >= $${params.length}`);
    }
    if (req.query.date_fin) {
      params.push(req.query.date_fin);
      conditions.push(`d.date_demande <= $${params.length}::date + INTERVAL '1 day'`);
    }
    if (req.query.q && req.query.q.trim().length >= 2) {
      params.push(`%${req.query.q.trim()}%`);
      conditions.push(`(d.reference ILIKE $${params.length} OR e.nom ILIKE $${params.length} OR e.prenoms ILIKE $${params.length} OR e.matricule_iipea ILIKE $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await db.query(`${SELECT_ENRICHI} ${where} ORDER BY d.date_demande DESC`, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur getDemandes:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.getDemandeById = async (req, res) => {
  try {
    const result = await db.query(`${SELECT_ENRICHI} WHERE d.id = $1 AND e.site_id = $2`, [req.params.id, req.user.departement_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Erreur getDemandeById:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Une demande non payée peut être annulée. Une demande PAYEE ne peut PAS être annulée depuis cette
// phase : aucun mécanisme de remboursement n'existe ailleurs dans ce projet à réutiliser, et en
// inventer un serait hors périmètre (§14, explicite : documenter le cas, ne pas l'implémenter).
// Une régularisation d'une demande déjà payée doit passer par la Comptabilité, manuellement, hors
// de cet écran, jusqu'à ce qu'un mécanisme de remboursement soit défini ailleurs dans le projet.
exports.annulerDemande = async (req, res) => {
  try {
    const { id } = req.params;
    const { motif } = req.body;
    if (!motif || !motif.trim()) {
      return res.status(400).json({ success: false, message: 'Un motif est obligatoire pour annuler une demande.' });
    }
    // Cloisonnement par site (correctif 2026-08-20) — même garde que getDemandeById/distribuerSurplus.
    const demandeResult = await db.query(
      `SELECT d.statut FROM demande_surplus_accessoire d
       JOIN etudiant e ON e.id = d.etudiant_id
       WHERE d.id = $1 AND e.site_id = $2`,
      [id, req.user.departement_id]
    );
    if (demandeResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    }
    const { statut } = demandeResult.rows[0];
    if (statut !== 'EN_ATTENTE_PAIEMENT') {
      return res.status(409).json({
        success: false,
        message: statut === 'PAYE' || statut === 'DISTRIBUE'
          ? "Cette demande est déjà payée — aucun mécanisme de remboursement n'existe actuellement dans ce projet. Contactez la Comptabilité pour une régularisation manuelle."
          : `Cette demande ne peut plus être annulée (statut actuel : ${statut}).`,
      });
    }
    const result = await db.query(
      `UPDATE demande_surplus_accessoire SET statut = 'ANNULE', motif_annulation = $1, annule_par = $2, date_annulation = now() WHERE id = $3 RETURNING id`,
      [motif.trim(), req.user.id, id]
    );
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE d.id = $1`, [result.rows[0].id]);
    res.status(200).json({ success: true, data: enrichi.rows[0] });
  } catch (error) {
    console.error('Erreur annulerDemande:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// Distribution d'une demande PAYE — séparée de sa création et de son encaissement (§12). Seul point
// qui touche le stock/crée une distribution pour un surplus, et seulement ici, seulement si PAYE.
exports.distribuerSurplus = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const siteId = req.user.departement_id;

    await client.query('BEGIN');

    // Verrou sur la demande : empêche deux clics concurrents de distribuer deux fois la même
    // demande (§13). Combiné au verrou sur l'accessoire (posé dans enregistrerMouvementStock,
    // Phase 2C) pour couvrir aussi le cas d'un stock concurrent avec une autre opération.
    const demandeResult = await client.query(
      `SELECT d.*, e.site_id
       FROM demande_surplus_accessoire d
       JOIN etudiant e ON e.id = d.etudiant_id
       WHERE d.id = $1 FOR UPDATE OF d`,
      [id]
    );
    if (demandeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    }
    const demande = demandeResult.rows[0];
    if (demande.site_id !== siteId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    }
    if (demande.statut === 'DISTRIBUE') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Cette demande a déjà été distribuée.' });
    }
    if (demande.statut !== 'PAYE') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Distribution impossible : cette demande n'est pas payée (statut actuel : ${demande.statut}).`,
      });
    }

    const emplacementStockId = await getEmplacementStockPourSite(client, siteId);

    const etudiantInfo = await client.query(
      `SELECT ec.nom AS ecole_nom, f.nom AS filiere_nom, n.libelle AS niveau_nom, c.nom AS classe_nom
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN departement dep ON dep.id = f.departement_id
       JOIN ecole ec ON ec.id = dep.ecole_id
       LEFT JOIN niveau n ON n.id = e.niveau_id
       LEFT JOIN groupe g ON g.id = e.groupe_id
       LEFT JOIN classe c ON c.id = g.classe_id
       WHERE e.id = $1`,
      [demande.etudiant_id]
    );
    const info = etudiantInfo.rows[0] || {};
    const siteResult = await client.query('SELECT nom FROM site WHERE id = $1', [siteId]);
    const numeroRecu = `REM-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    let distributionId;
    try {
      const distributionResult = await client.query(
        `INSERT INTO distribution (etudiant_id, annee_academique_id, agent_id, emplacement_stock_id, numero_recu,
           ecole_nom, filiere_nom, niveau_nom, classe_nom, site_nom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [demande.etudiant_id, demande.annee_academique_id, req.user.id, emplacementStockId, numeroRecu,
          info.ecole_nom ?? null, info.filiere_nom ?? null, info.niveau_nom ?? null, info.classe_nom ?? null, siteResult.rows[0]?.nom ?? null]
      );
      distributionId = distributionResult.rows[0].id;
    } catch (erreurEcriture) {
      await client.query('ROLLBACK');
      throw erreurEcriture;
    }

    try {
      // SEUL point d'écriture sur le grand-livre — le verrou FOR UPDATE posé dans
      // enregistrerMouvementStock (Phase 2C) est le filet de sécurité définitif contre une course
      // concurrente sur le stock (§12/§13, test §19).
      await enregistrerMouvementStock(client, {
        accessoireId: demande.accessoire_id,
        emplacementStockId,
        type: 'distribution',
        quantite: demande.quantite,
        referenceType: 'distribution',
        referenceId: distributionId,
        effectuePar: req.user.id,
        motif: `Surplus payant — demande ${demande.reference}`,
      });
      await client.query(
        `INSERT INTO ligne_distribution
           (distribution_id, accessoire_id, quantite, etudiant_id, annee_academique_id, est_supplementaire, demande_surplus_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [distributionId, demande.accessoire_id, demande.quantite, demande.etudiant_id, demande.annee_academique_id, demande.id]
      );
    } catch (erreurMetier) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: erreurMetier.message });
    }

    await client.query(
      `UPDATE demande_surplus_accessoire SET statut = 'DISTRIBUE', distribution_id = $1, distribue_par = $2, date_distribution = now() WHERE id = $3`,
      [distributionId, req.user.id, id]
    );

    await client.query('COMMIT');
    const enrichi = await db.query(`${SELECT_ENRICHI} WHERE d.id = $1`, [id]);
    res.status(200).json({ success: true, data: enrichi.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur distribuerSurplus:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

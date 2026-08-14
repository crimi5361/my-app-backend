const db = require('../config/db.config');
const { affecterClasse } = require('../services/classeGroupe.service');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

const METHODES_VALIDES = ['Espèces', 'Mobile Money', 'Orange Money', 'Wave'];

// ─── PEC institutionnelle 100 % initiée à la Caisse (Chantier 2) ───────────
// Réutilise entièrement prise_en_charge (aucune nouvelle table). Garde-fou "une seule PEC
// active/en attente à la fois par étudiant" — même règle que demanderPECSeule
// (paiyement.controller.js), pas une nouvelle règle. pourcentage_reduction est toujours 100 à
// l'initiation (seule option proposée au caissier) ; seul le Fondateur peut ensuite l'ajuster
// (validerPEC, même fichier que demanderPECSeule).
const creerPecInstitutionnelle = async (client, { etudiantId, montantScolarite, referencePec, userId, caisseId, anneeAcademiqueId }) => {
  const existante = await client.query(
    `SELECT 1 FROM prise_en_charge WHERE etudiant_id = $1 AND statut IN ('en_attente', 'initiee', 'valide')`,
    [etudiantId]
  );
  if (existante.rows.length > 0) {
    const err = new Error('Une prise en charge est déjà active ou en attente pour cet étudiant.');
    err.code = 'PEC_DEJA_EXISTANTE';
    throw err;
  }
  await client.query(
    `INSERT INTO prise_en_charge
       (etudiant_id, type_pec, nature_pec, pourcentage_reduction, montant_reduction, reference,
        statut, date_demande, initie_par, caisse_id, date_initiation, annee_academique_id)
     VALUES ($1, 'institution', 'institutionnelle', 100, $2, $3, 'initiee', now(), $4, $5, now(), $6)`,
    [etudiantId, montantScolarite, referencePec, userId, caisseId, anneeAcademiqueId]
  );
};

// Résout la caisse du site du caissier connecté, et sa session ouverte (s'il y en a une).
const getSessionOuverte = async (dbClient, userId, siteId) => {
  const result = await dbClient.query(
    `SELECT sc.* FROM session_caisse sc
     JOIN caisse c ON c.id = sc.caisse_id
     WHERE sc.caissier_id = $1 AND c.site_id = $2 AND sc.statut = 'OUVERTE'
     ORDER BY sc.date_ouverture DESC LIMIT 1`,
    [userId, siteId]
  );
  return result.rows[0] || null;
};

// ─── GET session de caisse active du caissier connecté ─────────────────────
exports.getSessionActive = async (req, res) => {
  try {
    const session = await getSessionOuverte(db, req.user.id, req.user.departement_id);
    res.status(200).json({ success: true, data: session });
  } catch (error) {
    console.error('Erreur getSessionActive:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST ouvrir la caisse du jour ──────────────────────────────────────────
exports.ouvrirSession = async (req, res) => {
  try {
    const { montant_ouverture } = req.body;
    if (montant_ouverture === undefined || isNaN(parseFloat(montant_ouverture)) || parseFloat(montant_ouverture) < 0) {
      return res.status(400).json({ success: false, message: 'Solde d\'ouverture invalide.' });
    }

    const caisseResult = await db.query('SELECT id FROM caisse WHERE site_id = $1', [req.user.departement_id]);
    if (caisseResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aucune caisse configurée pour votre site.' });
    }
    const caisseId = caisseResult.rows[0].id;

    const existante = await getSessionOuverte(db, req.user.id, req.user.departement_id);
    if (existante) {
      return res.status(409).json({ success: false, code: 'SESSION_DEJA_OUVERTE', message: 'Vous avez déjà une session de caisse ouverte.', data: existante });
    }

    const result = await db.query(
      `INSERT INTO session_caisse (caisse_id, caissier_id, date_ouverture, montant_ouverture, statut)
       VALUES ($1, $2, now(), $3, 'OUVERTE') RETURNING *`,
      [caisseId, req.user.id, montant_ouverture]
    );

    res.status(201).json({ success: true, message: 'Caisse ouverte avec succès.', data: result.rows[0] });
  } catch (error) {
    console.error('Erreur ouvrirSession:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST fermer la caisse du jour + rapport de clôture ────────────────────
exports.fermerSession = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const { montant_compte, observations } = req.body;
    if (montant_compte === undefined || isNaN(parseFloat(montant_compte)) || parseFloat(montant_compte) < 0) {
      return res.status(400).json({ success: false, message: 'Montant compté invalide.' });
    }

    await client.query('BEGIN');

    const sessionResult = await client.query(
      `SELECT * FROM session_caisse WHERE id = $1 AND caissier_id = $2 FOR UPDATE`,
      [id, req.user.id]
    );
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Session de caisse introuvable.' });
    }
    const session = sessionResult.rows[0];
    if (session.statut !== 'OUVERTE') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Cette session est déjà fermée.' });
    }

    await client.query(
      `UPDATE session_caisse SET date_fermeture = now(), montant_fermeture = $1, statut = 'FERMEE', observations = $2 WHERE id = $3`,
      [montant_compte, observations || null, id]
    );

    await client.query('COMMIT');

    const rapport = await buildRapportSession(id);
    res.status(200).json({ success: true, message: 'Caisse fermée avec succès.', data: rapport });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur fermerSession:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.', details: error.message });
  } finally {
    client.release();
  }
};

// Construit le rapport de clôture d'une session donnée (Chantier 2 BIS, 2026-08-14) : totaux,
// répartition par méthode (existant, inchangé), + répartition par type de frais/année
// académique, sorties (dépenses validées), détail ligne par ligne, écart et montant théorique
// désormais calculés ici (plus seulement dans le template EJS), observations de fermeture.
// Aucune règle de calcul existante n'est modifiée : uniquement des blocs supplémentaires.
const buildRapportSession = async (sessionId) => {
  const sessionResult = await db.query(
    `SELECT sc.*, c.libelle AS caisse_libelle, u.nom AS caissier_nom, u.code AS caissier_code
     FROM session_caisse sc
     JOIN caisse c ON c.id = sc.caisse_id
     JOIN utilisateur u ON u.id = sc.caissier_id
     WHERE sc.id = $1`,
    [sessionId]
  );
  if (sessionResult.rows.length === 0) return null;
  const session = sessionResult.rows[0];

  const [
    totauxResult,
    parMethodeResult,
    parTypeFraisResult,
    parAnneeResult,
    sortiesResult,
    detailResult,
  ] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS nb_paiements, COALESCE(SUM(montant), 0) AS total_encaisse
       FROM paiement WHERE session_caisse_id = $1`,
      [sessionId]
    ),
    db.query(
      `SELECT methode, COUNT(*) AS nb, COALESCE(SUM(montant), 0) AS total
       FROM paiement WHERE session_caisse_id = $1 GROUP BY methode ORDER BY methode`,
      [sessionId]
    ),
    // ✅ Même mécanisme que Supervision des caisses / Bilan des dépenses (Chantier 1) : NULL =
    // scolarité classique (valeur historique). Couvre automatiquement scolarité, PEC
    // institutionnelle (Chantier 2) et toute autre nature de paiement future.
    db.query(
      `SELECT COALESCE(NULLIF(p.type_frais, ''), 'scolarite') AS type_frais,
              COUNT(*) AS nb, COALESCE(SUM(p.montant), 0) AS total
       FROM paiement p WHERE p.session_caisse_id = $1
       GROUP BY COALESCE(NULLIF(p.type_frais, ''), 'scolarite')
       ORDER BY total DESC`,
      [sessionId]
    ),
    db.query(
      `SELECT a.id AS annee_id, a.annee, COUNT(*) AS nb, COALESCE(SUM(p.montant), 0) AS total
       FROM paiement p JOIN anneeacademique a ON a.id = p.annee_academique_id
       WHERE p.session_caisse_id = $1
       GROUP BY a.id, a.annee ORDER BY a.annee DESC`,
      [sessionId]
    ),
    // Sorties : dépenses VALIDEES uniquement (règle Chantier 1, jamais une dépense annulée dans
    // un bilan), de la caisse concernée, sur la période couverte par la session. La table
    // depense n'a pas de lien direct à une session_caisse (seulement à une caisse) — on scope
    // donc par date_depense entre l'ouverture et la fermeture (now() si encore ouverte).
    db.query(
      `SELECT d.id, d.date_depense, d.montant, d.motif, d.beneficiaire, d.mode_paiement,
              d.reference_justificatif, cd.libelle AS categorie_libelle
       FROM depense d
       LEFT JOIN categorie_depense cd ON cd.id = d.categorie_id
       WHERE d.caisse_id = $1 AND d.statut = 'VALIDEE'
         AND d.date_depense >= $2 AND d.date_depense <= COALESCE($3, now())
       ORDER BY d.date_depense`,
      [session.caisse_id, session.date_ouverture, session.date_fermeture]
    ),
    db.query(
      `SELECT p.id, p.date_paiement, p.montant, p.methode,
              COALESCE(NULLIF(p.type_frais, ''), 'scolarite') AS type_frais,
              r.numero_recu, e.nom AS etudiant_nom, e.prenoms AS etudiant_prenoms,
              e.matricule_iipea
       FROM paiement p
       LEFT JOIN recu r ON r.id = p.recu_id
       LEFT JOIN etudiant e ON e.id = p.etudiant_id
       WHERE p.session_caisse_id = $1
       ORDER BY p.date_paiement`,
      [sessionId]
    ),
  ]);

  const totalEncaisse = parseFloat(totauxResult.rows[0].total_encaisse);
  const totalSorties = sortiesResult.rows.reduce((s, d) => s + parseFloat(d.montant), 0);
  const montantTheorique = parseFloat(session.montant_ouverture) + totalEncaisse;
  const ecart = session.montant_fermeture !== null
    ? parseFloat(session.montant_fermeture) - montantTheorique
    : null;

  return {
    session,
    nb_paiements: parseInt(totauxResult.rows[0].nb_paiements, 10),
    total_encaisse: totalEncaisse,
    repartition_methode: parMethodeResult.rows.map(r => ({ methode: r.methode, nb: parseInt(r.nb, 10), total: parseFloat(r.total) })),
    repartition_type_frais: parTypeFraisResult.rows.map(r => ({ type_frais: r.type_frais, nb: parseInt(r.nb, 10), total: parseFloat(r.total) })),
    repartition_annee_academique: parAnneeResult.rows.map(r => ({ annee_id: r.annee_id, annee: r.annee, nb: parseInt(r.nb, 10), total: parseFloat(r.total) })),
    sorties: sortiesResult.rows.map(d => ({
      id: d.id, date_depense: d.date_depense, montant: parseFloat(d.montant), motif: d.motif,
      beneficiaire: d.beneficiaire, mode_paiement: d.mode_paiement,
      reference_justificatif: d.reference_justificatif, categorie_libelle: d.categorie_libelle,
    })),
    total_sorties: totalSorties,
    details_operations: detailResult.rows.map(p => ({
      id: p.id, date_paiement: p.date_paiement, montant: parseFloat(p.montant), methode: p.methode,
      type_frais: p.type_frais, numero_recu: p.numero_recu,
      etudiant_nom: p.etudiant_nom, etudiant_prenoms: p.etudiant_prenoms, matricule_iipea: p.matricule_iipea,
    })),
    montant_theorique: montantTheorique,
    ecart,
  };
};

// ─── GET rapport de clôture (réimpression) ──────────────────────────────────
exports.getRapportSession = async (req, res) => {
  try {
    const rapport = await buildRapportSession(req.params.id);
    if (!rapport) {
      return res.status(404).json({ success: false, message: 'Session introuvable.' });
    }
    res.status(200).json({ success: true, data: rapport });
  } catch (error) {
    console.error('Erreur getRapportSession:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET rapport de clôture — version imprimable (EJS) ──────────────────────
exports.afficherRapportSession = async (req, res) => {
  try {
    const rapport = await buildRapportSession(req.params.id);
    if (!rapport) {
      return res.status(404).send('Session de caisse introuvable.');
    }
    res.render('rapport_cloture_caisse', { rapport });
  } catch (error) {
    console.error('Erreur afficherRapportSession:', error);
    res.status(500).send('Erreur serveur lors de la génération du rapport.');
  }
};

// ─── GET dossier de réinscription par code de paiement (guichet caisse) ────
exports.rechercherDossierParCode = async (req, res) => {
  try {
    const { code } = req.query;
    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, message: 'Code de paiement requis.' });
    }

    const result = await db.query(
      `SELECT r.id AS reinscription_id, r.statut, r.montant_annuel_nouveau, r.code_paiement,
              r.nombre_versements_prevu, r.modalite_paiement, r.valide_scolarite,
              e.id AS etudiant_id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
              f.nom AS filiere_nom, n.libelle AS niveau_libelle, a.annee
       FROM reinscription r
       JOIN etudiant e ON e.id = r.etudiant_id
       LEFT JOIN filiere f ON f.id = r.id_filiere_retenu
       JOIN niveau n ON n.id = r.niveau_retenu_id
       JOIN anneeacademique a ON a.id = r.anneeacademique_id
       WHERE r.code_paiement = $1`,
      [code.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aucun dossier trouvé pour ce code.' });
    }
    const dossier = result.rows[0];
    if (dossier.statut === 'inscrit') {
      return res.status(409).json({ success: false, code: 'DEJA_PAYE', message: 'Ce dossier a déjà été payé et finalisé.' });
    }
    if (dossier.statut !== 'en_attente_paiement') {
      return res.status(409).json({ success: false, message: "Ce dossier n'est pas en attente de paiement." });
    }
    // ✅ Condition cumulative (jamais un remplacement du check statut ci-dessus) : un dossier de
    // réinscription venu du portail Web doit être vérifié par la scolarité avant tout paiement —
    // même garde-fou que l'admission Web (etudiant.valide_scolarite / caisse admission).
    if (dossier.valide_scolarite === false) {
      return res.status(409).json({ success: false, code: 'NON_VALIDE_SCOLARITE', message: "Ce dossier doit d'abord être validé par le Service de la Scolarité." });
    }

    res.status(200).json({ success: true, data: dossier });
  } catch (error) {
    console.error('Erreur rechercherDossierParCode:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST valider le paiement d'une réinscription (caisse) ─────────────────
// Dernière étape du workflow : c'est CETTE validation, et elle seule, qui rend la
// réinscription définitive — niveau/année/filière/statut/classe/groupe ne sont mis à jour
// qu'ici, jamais avant.
exports.validerPaiementReinscription = async (req, res) => {
  const client = await db.connect();
  try {
    const { code } = req.params;
    const { montant, methode, pec_institutionnelle, reference_pec } = req.body;

    if (!pec_institutionnelle) {
      if (!montant || isNaN(parseFloat(montant)) || parseFloat(montant) <= 0) {
        return res.status(400).json({ success: false, message: 'Montant du paiement invalide.' });
      }
      if (!methode || !METHODES_VALIDES.includes(methode)) {
        return res.status(400).json({ success: false, message: `Méthode de paiement invalide. Valeurs acceptées : ${METHODES_VALIDES.join(', ')}.` });
      }
    } else if (!reference_pec || !reference_pec.trim()) {
      return res.status(400).json({ success: false, message: 'La référence de la prise en charge institutionnelle est obligatoire.' });
    }

    await client.query('BEGIN');

    const session = await getSessionOuverte(client, req.user.id, req.user.departement_id);
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'CAISSE_FERMEE', message: 'Ouvrez votre caisse avant d\'encaisser un paiement.' });
    }

    const dossierResult = await client.query(
      `SELECT * FROM reinscription WHERE code_paiement = $1 FOR UPDATE`,
      [code.trim().toUpperCase()]
    );
    if (dossierResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Aucun dossier trouvé pour ce code.' });
    }
    const dossier = dossierResult.rows[0];
    if (dossier.statut === 'inscrit') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'DEJA_PAYE', message: 'Ce dossier a déjà été payé et finalisé.' });
    }
    if (dossier.statut !== 'en_attente_paiement') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: "Ce dossier n'est pas en attente de paiement." });
    }
    // ✅ Condition cumulative (jamais un remplacement du check statut ci-dessus) : un dossier de
    // réinscription venu du portail Web doit être vérifié par la scolarité avant tout paiement.
    if (dossier.valide_scolarite === false) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'NON_VALIDE_SCOLARITE', message: "Ce dossier doit d'abord être validé par le Service de la Scolarité." });
    }

    const etudiantResult = await client.query('SELECT * FROM etudiant WHERE id = $1', [dossier.etudiant_id]);
    const etudiant = etudiantResult.rows[0];

    // Clôture de l'ancienne année : avant d'écraser l'état courant de l'étudiant vers la
    // nouvelle année (plus bas), on préserve une trace durable de l'affectation classe/groupe/
    // niveau qu'il quitte — sans ça, cette ancienne année perd silencieusement cet étudiant de
    // ses effectifs dès que etudiant.groupe_id est réécrit (bug remonté par l'utilisateur).
    if (etudiant.annee_academique_id) {
      const dejaCloturee = await client.query(
        `SELECT 1 FROM historique_inscription WHERE etudiant_id = $1 AND annee_academique_id = $2 LIMIT 1`,
        [etudiant.id, etudiant.annee_academique_id]
      );
      if (dejaCloturee.rows.length === 0) {
        const ancienneScolarite = etudiant.scolarite_id
          ? (await client.query('SELECT * FROM scolarite WHERE id = $1', [etudiant.scolarite_id])).rows[0]
          : null;
        await client.query(
          `INSERT INTO historique_inscription (
             etudiant_id, type_evenement, annee_academique_id, niveau_id, id_filiere, groupe_id,
             statut_scolaire, montant_scolarite, scolarite_verse, scolarite_restante, statut_paiement,
             decision_academique, moyenne_annuelle, reinscription_id, valide_par, curcus_id
           ) VALUES ($1, 'cloture', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [etudiant.id, etudiant.annee_academique_id, etudiant.niveau_id, etudiant.id_filiere, etudiant.groupe_id,
           etudiant.statut_scolaire, ancienneScolarite?.montant_scolarite ?? null, ancienneScolarite?.scolarite_verse ?? null,
           ancienneScolarite?.scolarite_restante ?? null, ancienneScolarite?.statut_etudiant ?? null,
           dossier.decision_academique, dossier.moyenne_annuelle, dossier.id, req.user?.id || null, etudiant.curcus_id ?? null]
        );
      }
    }

    // ✅ Parcours JOUR/SOIR : le choix fait à la réinscription (dossier.curcus_id) prévaut sur
    // l'ancien parcours de l'étudiant (etudiant.curcus_id) — cOld reste le filet de sécurité pour
    // les niveaux qui ne requièrent aucun choix (dossier.curcus_id NULL, comportement inchangé).
    const infosResult = await client.query(
      `SELECT f.nom AS filiere_nom, f.sigle AS filiere_sigle, n.libelle AS niveau_libelle,
              tf.libelle AS type_filiere,
              COALESCE(cNew.id, cOld.id) AS curcus_id_resolu,
              COALESCE(cNew.type_parcours, cOld.type_parcours) AS cursus
       FROM filiere f
       JOIN typefiliere tf ON tf.id = f.type_filiere_id
       JOIN niveau n ON n.id = $1
       LEFT JOIN curcus cOld ON cOld.id = $2
       LEFT JOIN curcus cNew ON cNew.id = $3
       WHERE f.id = $4`,
      [dossier.niveau_retenu_id, etudiant.curcus_id, dossier.curcus_id, dossier.id_filiere_retenu]
    );
    if (infosResult.rows.length === 0) {
      throw new Error('Filière/niveau introuvable pour ce dossier.');
    }
    const infos = infosResult.rows[0];

    // Montant : le paiement caisse peut être un versement partiel, pas nécessairement le solde
    // complet — même principe que le premier paiement d'une nouvelle admission.
    const montantScolarite = parseFloat(dossier.montant_annuel_nouveau);

    if (pec_institutionnelle) {
      try {
        await creerPecInstitutionnelle(client, {
          etudiantId: dossier.etudiant_id,
          montantScolarite,
          referencePec: reference_pec.trim(),
          userId: req.user.id,
          caisseId: session.caisse_id,
          anneeAcademiqueId: dossier.anneeacademique_id,
        });
      } catch (pecErr) {
        await client.query('ROLLBACK');
        if (pecErr.code === 'PEC_DEJA_EXISTANTE') {
          return res.status(409).json({ success: false, code: pecErr.code, message: pecErr.message });
        }
        throw pecErr;
      }
    }

    const montantPaye = pec_institutionnelle ? 0 : parseFloat(montant);
    // PEC institutionnelle 100 % : l'étudiant est traité comme devant 0 F dès l'initiation
    // (pas seulement "rien versé pour l'instant" — la formule generale montantScolarite -
    // montantPaye donnerait ici le montant total, ce qui serait faux). scolarite_restante ne
    // redevient positif qu'après la décision du Fondateur (validerPEC, cf. Chantier 2).
    const scolariteRestante = pec_institutionnelle ? 0 : (montantScolarite - montantPaye);
    if (scolariteRestante < 0) {
      throw new Error('Le montant payé ne peut pas dépasser le montant total de la scolarité.');
    }
    const statutEtudiantScolarite = Math.abs(scolariteRestante) < 0.01 ? 'SOLDE' : 'NON_SOLDE';

    const scolariteResult = await client.query(
      `INSERT INTO scolarite (montant_scolarite, scolarite_verse, scolarite_restante, statut_etudiant)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [montantScolarite, montantPaye, scolariteRestante, statutEtudiantScolarite]
    );

    // Chantier 6 : groupe_id remis à NULL explicitement — auparavant, ce champ était écrasé par
    // affecterClasseEtGroupe (nouveau groupe attribué automatiquement) juste après cette requête ;
    // maintenant que le groupe n'est plus auto-attribué, rien d'autre ne nettoierait l'ancien
    // groupe_id (celui de la classe quittée) si on ne le fait pas ici explicitement.
    await client.query(
      `UPDATE etudiant SET
         niveau_id = $1, annee_academique_id = $2, scolarite_id = $3,
         id_filiere = $4, statut_scolaire = $5, standing = 'Inscrit',
         curcus_id = COALESCE($6, curcus_id), groupe_id = NULL
       WHERE id = $7`,
      [dossier.niveau_retenu_id, dossier.anneeacademique_id, scolariteResult.rows[0].id,
       dossier.id_filiere_retenu, dossier.statut_scolaire_retenu, dossier.curcus_id, dossier.etudiant_id]
    );

    // Affectation classe : toujours celle de la NOUVELLE année/niveau, jamais l'ancienne classe
    // de l'étudiant. Chantier 6 : le groupe pédagogique réel n'est plus attribué automatiquement
    // — l'ancien groupe appartenait à l'ancienne classe, quittée par définition lors d'une
    // réinscription. Chantier 11 (sous-phase 2) : seul le groupe technique "primaire" de la
    // nouvelle classe est réaffecté automatiquement, et uniquement si cette classe relève de la
    // nouvelle architecture (groupePrimaireId reste null pour toute classe déjà existante avant
    // ce chantier — notamment toutes celles des années antérieures à 2026-2027).
    const { groupePrimaireId } = await affecterClasse(client, {
      etudiantId: dossier.etudiant_id,
      filiereNom: infos.filiere_nom,
      filiereSigle: infos.filiere_sigle,
      niveauLibelle: infos.niveau_libelle,
      cursus: infos.cursus,
      curcusId: infos.curcus_id_resolu,
      anneeAcademiqueId: dossier.anneeacademique_id,
      filiereId: dossier.id_filiere_retenu,
      niveauId: dossier.niveau_retenu_id,
    });
    if (groupePrimaireId) {
      await client.query('UPDATE etudiant SET groupe_id = $1 WHERE id = $2', [groupePrimaireId, dossier.etudiant_id]);
    }
    const groupeId = groupePrimaireId;

    // Historique : trace permanente de ce cycle, consultable même une fois que l'état "courant"
    // de l'étudiant aura été réécrit par une réinscription future (bug #9 du tour précédent).
    await client.query(
      `INSERT INTO historique_inscription (
         etudiant_id, type_evenement, annee_academique_id, niveau_id, id_filiere, groupe_id,
         statut_scolaire, montant_scolarite, scolarite_verse, scolarite_restante, statut_paiement,
         decision_academique, moyenne_annuelle, reinscription_id, valide_par, curcus_id
       ) VALUES ($1, 'reinscription', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [dossier.etudiant_id, dossier.anneeacademique_id, dossier.niveau_retenu_id, dossier.id_filiere_retenu, groupeId,
       dossier.statut_scolaire_retenu, montantScolarite, montantPaye, scolariteRestante, statutEtudiantScolarite,
       dossier.decision_academique, dossier.moyenne_annuelle, dossier.id, req.user?.id || null, dossier.curcus_id ?? null]
    );

    const datePaiement = new Date();
    const numeroRecu = `RECU-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const recuResult = await client.query(
      `INSERT INTO recu (numero_recu, date_emission, montant, emetteur) VALUES ($1, $2, $3, $4) RETURNING id`,
      [numeroRecu, datePaiement, montantPaye, req.user?.code || null]
    );

    // Trace de l'opération à la Caisse même à 0 FCFA (PEC institutionnelle) — voir le même choix
    // dans validerPaiementAdmission ci-dessus.
    const paiementResult = await client.query(
      `INSERT INTO paiement (montant, date_paiement, methode, effectue_par, etudiant_id, recu_id, annee_academique_id, session_caisse_id, caisse_id, type_frais)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [montantPaye, datePaiement, pec_institutionnelle ? 'Prise en charge institutionnelle' : methode, req.user?.id || null, dossier.etudiant_id, recuResult.rows[0].id, dossier.anneeacademique_id, session.id, session.caisse_id, pec_institutionnelle ? 'pec_institutionnelle' : null]
    );

    await client.query(
      `UPDATE reinscription SET statut = 'inscrit', updated_at = now() WHERE id = $1`,
      [dossier.id]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: pec_institutionnelle
        ? 'Prise en charge institutionnelle initiée : réinscription finalisée, en attente de confirmation du Fondateur.'
        : 'Paiement validé : réinscription finalisée.',
      data: {
        etudiant_id: dossier.etudiant_id,
        paiement_id: paiementResult.rows[0].id,
        recu_id: recuResult.rows[0].id,
        numero_recu: numeroRecu,
        scolarite_verse: montantPaye,
        scolarite_restante: scolariteRestante,
        statut_etudiant: statutEtudiantScolarite,
        pec_institutionnelle: !!pec_institutionnelle,
        reference_pec: pec_institutionnelle ? reference_pec.trim() : undefined
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur validerPaiementReinscription:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.', details: error.message });
  } finally {
    client.release();
  }
};

// ─── GET recherche libre d'étudiant (guichet caisse) ────────────────────────
exports.rechercherEtudiantCaisse = async (req, res) => {
  try {
    const { q } = req.query;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (e.site_id) existant.
    const ecoleCond = ecoleId !== null ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)' : '';
    const params = ecoleId !== null ? [siteId, `%${q.trim()}%`, ecoleId] : [siteId, `%${q.trim()}%`];

    const result = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.standing, e.code_paiement,
              f.nom AS filiere, n.libelle AS niveau,
              s.scolarite_verse, s.montant_scolarite, s.scolarite_restante, s.statut_etudiant,
              r.code_paiement AS reinscription_code_paiement, r.statut AS reinscription_statut
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       LEFT JOIN scolarite s ON s.id = e.scolarite_id
       LEFT JOIN reinscription r ON r.etudiant_id = e.id AND r.statut = 'en_attente_paiement'
       WHERE e.site_id = $1
         AND (
           e.nom ILIKE $2 OR e.prenoms ILIKE $2 OR e.matricule_iipea ILIKE $2
           OR (e.nom || ' ' || e.prenoms) ILIKE $2
         )
         ${ecoleCond}
       ORDER BY e.nom, e.prenoms
       LIMIT 20`,
      params
    );

    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur rechercherEtudiantCaisse:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET historique des années académiques d'un étudiant (multi-années) ────
// Année en cours : lue en direct sur scolarite (via etudiant.scolarite_id).
// Années vraiment antérieures (étudiant déjà réinscrit depuis) : instantané
// figé dans historique_inscription, seule trace durable une fois l'étudiant
// passé à l'année suivante.
exports.getHistoriqueAnneesEtudiant = async (req, res) => {
  try {
    const { id } = req.params;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (e.site_id) existant.
    const ecoleCond = ecoleId !== null ? 'AND e.id_filiere IN (SELECT id FROM filiere WHERE departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))' : '';
    const params = ecoleId !== null ? [id, siteId, ecoleId] : [id, siteId];

    const etudiantResult = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url, e.standing,
              e.annee_academique_id, e.scolarite_id
       FROM etudiant e
       WHERE e.id = $1 AND e.site_id = $2
         ${ecoleCond}`,
      params
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];
    const annees = [];

    // ✅ École/département/cursus/classe/groupe ajoutés (même chaîne de jointures que
    // getEtudiantById, controllers/etudiant.controller.js) pour que la section "Informations
    // Académiques" de la fiche étudiant puisse réutiliser cette même requête — une seule source
    // de vérité pour l'historique académique, partagée avec la section financière.
    if (etudiant.scolarite_id) {
      const courant = await db.query(
        `SELECT e.annee_academique_id, aa.annee, n.libelle AS niveau, f.nom AS filiere, f.sigle AS filiere_sigle,
                ec.nom AS ecole, dept.nom AS departement, cur.type_parcours AS cursus,
                c.nom AS classe, g.nom AS groupe,
                s.montant_scolarite, s.scolarite_verse, s.scolarite_restante,
                s.statut_etudiant AS statut_paiement, e.statut_scolaire, NULL::text AS type_evenement
         FROM etudiant e
         JOIN scolarite s ON s.id = e.scolarite_id
         LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
         LEFT JOIN niveau n ON n.id = e.niveau_id
         LEFT JOIN filiere f ON f.id = e.id_filiere
         LEFT JOIN departement dept ON dept.id = f.departement_id
         LEFT JOIN ecole ec ON ec.id = dept.ecole_id
         LEFT JOIN curcus cur ON cur.id = e.curcus_id
         LEFT JOIN groupe g ON g.id = e.groupe_id
         LEFT JOIN classe c ON c.id = g.classe_id
         WHERE e.id = $1`,
        [id]
      );
      if (courant.rows.length > 0) {
        annees.push({ ...courant.rows[0], source: 'current', is_current: true });
      }
    }

    const passees = await db.query(
      `SELECT DISTINCT ON (hi.annee_academique_id)
              hi.annee_academique_id, aa.annee, n.libelle AS niveau, f.nom AS filiere, f.sigle AS filiere_sigle,
              ec.nom AS ecole, dept.nom AS departement, cur.type_parcours AS cursus,
              c.nom AS classe, g.nom AS groupe,
              hi.montant_scolarite, hi.scolarite_verse, hi.scolarite_restante,
              hi.statut_paiement, hi.statut_scolaire, hi.type_evenement
       FROM historique_inscription hi
       LEFT JOIN anneeacademique aa ON aa.id = hi.annee_academique_id
       LEFT JOIN niveau n ON n.id = hi.niveau_id
       LEFT JOIN filiere f ON f.id = hi.id_filiere
       LEFT JOIN departement dept ON dept.id = f.departement_id
       LEFT JOIN ecole ec ON ec.id = dept.ecole_id
       LEFT JOIN curcus cur ON cur.id = hi.curcus_id
       LEFT JOIN groupe g ON g.id = hi.groupe_id
       LEFT JOIN classe c ON c.id = g.classe_id
       WHERE hi.etudiant_id = $1
         AND hi.annee_academique_id IS DISTINCT FROM $2
       ORDER BY hi.annee_academique_id, hi.created_at DESC`,
      [id, etudiant.annee_academique_id]
    );
    passees.rows.forEach(row => annees.push({ ...row, source: 'historique', is_current: false }));

    annees.sort((a, b) => (b.annee || '').localeCompare(a.annee || ''));

    res.status(200).json({
      success: true,
      data: {
        etudiant: {
          id: etudiant.id, nom: etudiant.nom, prenoms: etudiant.prenoms,
          matricule_iipea: etudiant.matricule_iipea, photo_url: etudiant.photo_url,
          standing: etudiant.standing
        },
        annees
      }
    });
  } catch (error) {
    console.error('Erreur getHistoriqueAnneesEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET détail + historique des versements d'une année pour un étudiant ───
exports.getPaiementsAnneeEtudiant = async (req, res) => {
  try {
    const { id, anneeAcademiqueId } = req.params;
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    const anneeId = parseInt(anneeAcademiqueId, 10);

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (site_id) existant.
    const ecoleCond = ecoleId !== null ? 'AND id_filiere IN (SELECT id FROM filiere WHERE departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))' : '';
    const etudiantParams = ecoleId !== null ? [id, siteId, ecoleId] : [id, siteId];

    const etudiantResult = await db.query(
      `SELECT id, annee_academique_id, scolarite_id FROM etudiant WHERE id = $1 AND site_id = $2 ${ecoleCond}`,
      etudiantParams
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];
    const isAnneeCourante = Number(etudiant.annee_academique_id) === anneeId;

    let anneeInfo;
    if (isAnneeCourante) {
      const result = await db.query(
        `SELECT e.annee_academique_id, aa.annee, n.libelle AS niveau, f.nom AS filiere,
                s.montant_scolarite, s.scolarite_verse, s.scolarite_restante,
                s.statut_etudiant AS statut_paiement
         FROM etudiant e
         JOIN scolarite s ON s.id = e.scolarite_id
         LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
         LEFT JOIN niveau n ON n.id = e.niveau_id
         LEFT JOIN filiere f ON f.id = e.id_filiere
         WHERE e.id = $1`,
        [id]
      );
      anneeInfo = result.rows[0];
    } else {
      const result = await db.query(
        `SELECT hi.annee_academique_id, aa.annee, n.libelle AS niveau, f.nom AS filiere,
                hi.montant_scolarite, hi.scolarite_verse, hi.scolarite_restante,
                hi.statut_paiement
         FROM historique_inscription hi
         LEFT JOIN anneeacademique aa ON aa.id = hi.annee_academique_id
         LEFT JOIN niveau n ON n.id = hi.niveau_id
         LEFT JOIN filiere f ON f.id = hi.id_filiere
         WHERE hi.etudiant_id = $1 AND hi.annee_academique_id = $2
         ORDER BY hi.created_at DESC LIMIT 1`,
        [id, anneeId]
      );
      anneeInfo = result.rows[0];
    }

    if (!anneeInfo) {
      return res.status(404).json({ success: false, message: 'Aucune donnée pour cette année académique.' });
    }
    anneeInfo.is_current = isAnneeCourante;

    const paiements = await db.query(
      `SELECT p.id, p.montant, p.date_paiement, p.methode, p.effectue_par,
              r.id AS recu_id, r.numero_recu, r.date_emission, r.emetteur,
              u.nom AS caissier_nom, p.session_caisse_id
       FROM paiement p
       LEFT JOIN recu r ON r.id = p.recu_id
       LEFT JOIN utilisateur u ON u.id::text = p.effectue_par
       WHERE p.etudiant_id = $1 AND p.annee_academique_id = $2
       ORDER BY p.date_paiement DESC, p.id DESC`,
      [id, anneeId]
    );

    res.status(200).json({ success: true, data: { annee: anneeInfo, paiements: paiements.rows } });
  } catch (error) {
    console.error('Erreur getPaiementsAnneeEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST enregistrer un paiement pour un étudiant sur une année donnée ────
// Année en cours ou vraiment antérieure — contrairement aux validations
// admission/réinscription, pas de code_paiement : l'étudiant est déjà inscrit,
// c'est un versement libre sur un solde existant (scolarite ou historique_inscription).
exports.enregistrerPaiementAnneeEtudiant = async (req, res) => {
  const client = await db.connect();
  try {
    const { id, anneeAcademiqueId } = req.params;
    const { montant, methode } = req.body;
    const ecoleId = getEcoleScopeFromUser(req);
    const anneeId = parseInt(anneeAcademiqueId, 10);

    if (!montant || isNaN(parseFloat(montant)) || parseFloat(montant) <= 0) {
      return res.status(400).json({ success: false, message: 'Montant du paiement invalide.' });
    }
    if (!methode || !METHODES_VALIDES.includes(methode)) {
      return res.status(400).json({ success: false, message: `Méthode de paiement invalide. Valeurs acceptées : ${METHODES_VALIDES.join(', ')}.` });
    }

    await client.query('BEGIN');

    const session = await getSessionOuverte(client, req.user.id, req.user.departement_id);
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'CAISSE_FERMEE', message: 'Ouvrez votre caisse avant d\'encaisser un paiement.' });
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (site_id) existant.
    const ecoleCondEnreg = ecoleId !== null ? 'AND id_filiere IN (SELECT id FROM filiere WHERE departement_id IN (SELECT id FROM departement WHERE ecole_id = $3))' : '';
    const etudiantGuardParams = ecoleId !== null ? [id, req.user.departement_id, ecoleId] : [id, req.user.departement_id];

    const etudiantResult = await client.query(
      `SELECT id, annee_academique_id, scolarite_id FROM etudiant WHERE id = $1 AND site_id = $2 ${ecoleCondEnreg} FOR UPDATE`,
      etudiantGuardParams
    );
    if (etudiantResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];
    const isAnneeCourante = Number(etudiant.annee_academique_id) === anneeId;
    const montantPaye = parseFloat(montant);

    let nouveauVerse, nouveauRestant, nouveauStatut;

    if (isAnneeCourante) {
      if (!etudiant.scolarite_id) {
        await client.query('ROLLBACK');
        return res.status(500).json({ success: false, message: 'Aucune scolarité active pour cet étudiant.' });
      }
      const scolariteResult = await client.query('SELECT * FROM scolarite WHERE id = $1 FOR UPDATE', [etudiant.scolarite_id]);
      const scolarite = scolariteResult.rows[0];
      const scolariteRestante = parseFloat(scolarite.scolarite_restante);
      if (scolariteRestante <= 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Cette année est déjà soldée.' });
      }
      if (montantPaye > scolariteRestante) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Le montant dépasse le solde restant.' });
      }
      nouveauVerse = parseFloat(scolarite.scolarite_verse) + montantPaye;
      nouveauRestant = scolariteRestante - montantPaye;
      nouveauStatut = Math.abs(nouveauRestant) < 0.01 ? 'SOLDE' : 'NON_SOLDE';
      await client.query(
        `UPDATE scolarite SET scolarite_verse = $1, scolarite_restante = $2, statut_etudiant = $3 WHERE id = $4`,
        [nouveauVerse, nouveauRestant, nouveauStatut, scolarite.id]
      );
    } else {
      const historiqueResult = await client.query(
        `SELECT * FROM historique_inscription WHERE etudiant_id = $1 AND annee_academique_id = $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [id, anneeId]
      );
      if (historiqueResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Aucun historique trouvé pour cette année académique.' });
      }
      const historique = historiqueResult.rows[0];
      const scolariteRestante = parseFloat(historique.scolarite_restante);
      if (scolariteRestante <= 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Cette année est déjà soldée.' });
      }
      if (montantPaye > scolariteRestante) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Le montant dépasse le solde restant.' });
      }
      nouveauVerse = parseFloat(historique.scolarite_verse) + montantPaye;
      nouveauRestant = scolariteRestante - montantPaye;
      nouveauStatut = Math.abs(nouveauRestant) < 0.01 ? 'SOLDE' : 'NON_SOLDE';
      await client.query(
        `UPDATE historique_inscription SET scolarite_verse = $1, scolarite_restante = $2, statut_paiement = $3 WHERE id = $4`,
        [nouveauVerse, nouveauRestant, nouveauStatut, historique.id]
      );
    }

    const datePaiement = new Date();
    const numeroRecu = `RECU-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const recuResult = await client.query(
      `INSERT INTO recu (numero_recu, date_emission, montant, emetteur) VALUES ($1, $2, $3, $4) RETURNING id`,
      [numeroRecu, datePaiement, montantPaye, req.user?.code || null]
    );
    const paiementResult = await client.query(
      `INSERT INTO paiement (montant, date_paiement, methode, effectue_par, etudiant_id, recu_id, annee_academique_id, session_caisse_id, caisse_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [montantPaye, datePaiement, methode, req.user?.id || null, id, recuResult.rows[0].id, anneeId, session.id, session.caisse_id]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Paiement enregistré.',
      data: {
        etudiant_id: parseInt(id, 10),
        annee_academique_id: anneeId,
        paiement_id: paiementResult.rows[0].id,
        recu_id: recuResult.rows[0].id,
        numero_recu: numeroRecu,
        scolarite_verse: nouveauVerse,
        scolarite_restante: nouveauRestant,
        statut_etudiant: nouveauStatut
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur enregistrerPaiementAnneeEtudiant:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.', details: error.message });
  } finally {
    client.release();
  }
};

// ─── GET statistiques du tableau de bord caisse (scope site du caissier) ───
exports.getDashboardStats = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const caissierId = req.user.id;

    const caisseResult = await db.query('SELECT id FROM caisse WHERE site_id = $1', [siteId]);
    const caisseId = caisseResult.rows[0]?.id || null;

    const sessionActive = await getSessionOuverte(db, caissierId, siteId);

    // Toutes les statistiques "aujourd'hui" ci-dessous sont propres au caissier connecté (son
    // activité personnelle), pas globales au site — chaque caissier gère sa propre caisse.
    const totauxJourResult = await db.query(
      `SELECT COUNT(*) AS nb_paiements, COALESCE(SUM(p.montant), 0) AS total_encaisse
       FROM paiement p JOIN caisse c ON c.id = p.caisse_id
       WHERE c.site_id = $1 AND p.effectue_par = $2::text AND p.date_paiement = CURRENT_DATE`,
      [siteId, caissierId]
    );

    const parMethodeResult = await db.query(
      `SELECT p.methode, COUNT(*) AS nb, COALESCE(SUM(p.montant), 0) AS total
       FROM paiement p JOIN caisse c ON c.id = p.caisse_id
       WHERE c.site_id = $1 AND p.effectue_par = $2::text AND p.date_paiement = CURRENT_DATE
       GROUP BY p.methode ORDER BY p.methode`,
      [siteId, caissierId]
    );

    // Inscriptions/réinscriptions validées = comptées directement depuis historique_inscription,
    // qui trace précisément qui (valide_par) a validé chaque dossier et quand.
    const validationsResult = await db.query(
      `SELECT type_evenement, COUNT(*) AS nb
       FROM historique_inscription
       WHERE valide_par = $1 AND created_at::date = CURRENT_DATE
       GROUP BY type_evenement`,
      [caissierId]
    );
    const inscriptionsValidees = validationsResult.rows.find(r => r.type_evenement === 'admission')?.nb || 0;
    const reinscriptionsValidees = validationsResult.rows.find(r => r.type_evenement === 'reinscription')?.nb || 0;

    // Dossiers en attente : file d'attente partagée par tout le site (pas encore réclamée par un
    // caissier en particulier), volontairement non filtrée par caissier.
    const paiementsEnAttenteResult = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM etudiant WHERE standing = 'en attente' AND site_id = $1) AS admissions_en_attente,
         (SELECT COUNT(*) FROM reinscription r JOIN etudiant e ON e.id = r.etudiant_id
            WHERE r.statut = 'en_attente_paiement' AND e.site_id = $1) AS reinscriptions_en_attente`,
      [siteId]
    );

    const dernieresOperationsResult = await db.query(
      `SELECT p.id, p.montant, p.methode, p.date_paiement, e.nom, e.prenoms, r.numero_recu
       FROM paiement p
       JOIN etudiant e ON e.id = p.etudiant_id
       LEFT JOIN recu r ON r.id = p.recu_id
       JOIN caisse c ON c.id = p.caisse_id
       WHERE c.site_id = $1 AND p.effectue_par = $2::text
       ORDER BY p.id DESC LIMIT 10`,
      [siteId, caissierId]
    );

    const evolutionResult = await db.query(
      `SELECT p.date_paiement AS jour, COALESCE(SUM(p.montant), 0) AS total
       FROM paiement p JOIN caisse c ON c.id = p.caisse_id
       WHERE c.site_id = $1 AND p.effectue_par = $2::text AND p.date_paiement >= CURRENT_DATE - INTERVAL '13 days'
       GROUP BY p.date_paiement ORDER BY p.date_paiement`,
      [siteId, caissierId]
    );

    // Point 6 : exploiter des données déjà modélisées mais jamais affichées côté caisse (kit, PEC)
    // — informations opérationnelles partagées, non rattachées à un caissier en particulier.
    const kitPecJourResult = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM kit WHERE deposer = true AND date_enregistrement::date = CURRENT_DATE) AS kits_deposes,
         (SELECT COUNT(*) FROM prise_en_charge WHERE statut IN ('en_attente', 'initiee')) AS pec_en_attente`
    );

    res.status(200).json({
      success: true,
      data: {
        caisse_id: caisseId,
        session_active: sessionActive,
        aujourd_hui: {
          total_encaisse: parseFloat(totauxJourResult.rows[0].total_encaisse),
          nb_paiements: parseInt(totauxJourResult.rows[0].nb_paiements, 10),
          repartition_methode: parMethodeResult.rows.map(r => ({ methode: r.methode, nb: parseInt(r.nb, 10), total: parseFloat(r.total) })),
          inscriptions_validees: parseInt(inscriptionsValidees, 10),
          reinscriptions_validees: parseInt(reinscriptionsValidees, 10),
        },
        en_attente: {
          admissions: parseInt(paiementsEnAttenteResult.rows[0].admissions_en_attente, 10),
          reinscriptions: parseInt(paiementsEnAttenteResult.rows[0].reinscriptions_en_attente, 10),
        },
        dernieres_operations: dernieresOperationsResult.rows,
        evolution_encaissements: evolutionResult.rows.map(r => ({ jour: r.jour, total: parseFloat(r.total) })),
        kits_deposes_aujourdhui: parseInt(kitPecJourResult.rows[0].kits_deposes, 10),
        pec_en_attente: parseInt(kitPecJourResult.rows[0].pec_en_attente, 10),
      }
    });
  } catch (error) {
    console.error('Erreur getDashboardStats:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET liste des caisses du site (pour le sélecteur de supervision) ──────
exports.listerCaissesSite = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const result = await db.query(
      'SELECT id, code, libelle, statut FROM caisse WHERE site_id = $1 ORDER BY libelle',
      [siteId]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur listerCaissesSite:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET supervision d'une caisse (Chantier Comptabilité, priorité 1, point 2) ──────────────
// Vue agrégée TOUTES sessions/caissiers confondus (à la différence de getRapportSession, scopé à
// une session précise, et de getDashboardStats, scopé à l'activité du jour du caissier connecté).
// Objectif explicite du chantier : "expliquer précisément d'où vient l'argent encaissé et à
// quelle année/activité il correspond" — répartition par année académique, par type de paiement
// et par caissier, sans aucune nouvelle table (paiement.annee_academique_id/type_frais existent
// déjà, migration 021bis).
exports.getSupervisionCaisse = async (req, res) => {
  try {
    const { caisseId } = req.params;
    const siteId = req.user.departement_id;

    const caisseResult = await db.query(
      'SELECT id, code, libelle, statut, site_id FROM caisse WHERE id = $1',
      [caisseId]
    );
    if (caisseResult.rows.length === 0 || caisseResult.rows[0].site_id !== siteId) {
      return res.status(404).json({ success: false, message: 'Caisse introuvable.' });
    }
    const caisse = caisseResult.rows[0];

    const [totalResult, parAnneeResult, parTypeResult, parCaissierResult, evolutionResult] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS nb, COALESCE(SUM(montant), 0) AS total FROM paiement WHERE caisse_id = $1`,
        [caisseId]
      ),

      db.query(
        `SELECT a.id AS annee_id, a.annee, COUNT(*) AS nb, COALESCE(SUM(p.montant), 0) AS total
         FROM paiement p JOIN anneeacademique a ON a.id = p.annee_academique_id
         WHERE p.caisse_id = $1
         GROUP BY a.id, a.annee ORDER BY a.annee DESC`,
        [caisseId]
      ),

      // ✅ type_frais NULL = paiement de scolarité classique (valeur historique, avant l'ajout de
      // cette colonne) — même hypothèse que le reste de l'application, pas une nouvelle règle.
      db.query(
        `SELECT COALESCE(NULLIF(p.type_frais, ''), 'scolarite') AS type_frais,
                COUNT(*) AS nb, COALESCE(SUM(p.montant), 0) AS total
         FROM paiement p WHERE p.caisse_id = $1
         GROUP BY COALESCE(NULLIF(p.type_frais, ''), 'scolarite')
         ORDER BY total DESC`,
        [caisseId]
      ),

      // ✅ Même jointure effectue_par::integer = utilisateur.id que paiyement.controller.js
      // (historique paiements) — pas une nouvelle convention.
      db.query(
        `SELECT u.id AS caissier_id, u.nom AS caissier_nom,
                COUNT(*) AS nb, COALESCE(SUM(p.montant), 0) AS total,
                MIN(p.date_paiement) AS premiere_operation, MAX(p.date_paiement) AS derniere_operation
         FROM paiement p LEFT JOIN utilisateur u ON p.effectue_par::integer = u.id
         WHERE p.caisse_id = $1
         GROUP BY u.id, u.nom ORDER BY total DESC`,
        [caisseId]
      ),

      db.query(
        `SELECT date_trunc('month', p.date_paiement) AS mois, COALESCE(SUM(p.montant), 0) AS total
         FROM paiement p WHERE p.caisse_id = $1
         GROUP BY date_trunc('month', p.date_paiement) ORDER BY mois`,
        [caisseId]
      ),
    ]);

    res.status(200).json({
      success: true,
      data: {
        caisse,
        total_encaisse: parseFloat(totalResult.rows[0].total),
        nb_operations: parseInt(totalResult.rows[0].nb, 10),
        par_annee_academique: parAnneeResult.rows.map((r) => ({
          annee_id: r.annee_id, annee: r.annee, nb: parseInt(r.nb, 10), total: parseFloat(r.total),
        })),
        par_type: parTypeResult.rows.map((r) => ({
          type_frais: r.type_frais, nb: parseInt(r.nb, 10), total: parseFloat(r.total),
        })),
        par_caissier: parCaissierResult.rows.map((r) => ({
          caissier_id: r.caissier_id, caissier_nom: r.caissier_nom, nb: parseInt(r.nb, 10),
          total: parseFloat(r.total), premiere_operation: r.premiere_operation, derniere_operation: r.derniere_operation,
        })),
        evolution_mensuelle: evolutionResult.rows.map((r) => ({ mois: r.mois, total: parseFloat(r.total) })),
      },
    });
  } catch (error) {
    console.error('Erreur getSupervisionCaisse:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET liste des paiements avec filtres (paiements du jour / historique) ─
exports.getPaiements = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    const isAdminOuComptable = ['admin', 'comptabilite'].includes(req.user.role);

    const whereClauses = ['c.site_id = $1'];
    const params = [siteId];

    if (!isAdminOuComptable || req.query.mine === 'true') {
      whereClauses.push(`p.effectue_par = $${params.length + 1}::text`);
      params.push(String(req.user.id));
    }
    if (req.query.date) {
      whereClauses.push(`p.date_paiement = $${params.length + 1}`);
      params.push(req.query.date);
    }
    if (req.query.etudiant) {
      whereClauses.push(`(e.nom ILIKE $${params.length + 1} OR e.prenoms ILIKE $${params.length + 1} OR e.matricule_iipea ILIKE $${params.length + 1})`);
      params.push(`%${req.query.etudiant}%`);
    }
    if (req.query.numero_recu) {
      whereClauses.push(`r.numero_recu ILIKE $${params.length + 1}`);
      params.push(`%${req.query.numero_recu}%`);
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (c.site_id) existant.
    if (ecoleId !== null) {
      whereClauses.push(`e.id_filiere IN (SELECT id FROM filiere WHERE departement_id IN (SELECT id FROM departement WHERE ecole_id = $${params.length + 1}))`);
      params.push(ecoleId);
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;

    const countResult = await db.query(
      `SELECT COUNT(*) FROM paiement p
       JOIN etudiant e ON e.id = p.etudiant_id
       LEFT JOIN recu r ON r.id = p.recu_id
       JOIN caisse c ON c.id = p.caisse_id
       WHERE ${whereClauses.join(' AND ')}`,
      params
    );

    const dataResult = await db.query(
      `SELECT p.id, p.montant, p.methode, p.date_paiement, p.etudiant_id,
              e.nom, e.prenoms, e.matricule_iipea,
              r.numero_recu, r.id AS recu_id,
              u.nom AS caissier_nom
       FROM paiement p
       JOIN etudiant e ON e.id = p.etudiant_id
       LEFT JOIN recu r ON r.id = p.recu_id
       JOIN caisse c ON c.id = p.caisse_id
       LEFT JOIN utilisateur u ON u.id::text = p.effectue_par
       WHERE ${whereClauses.join(' AND ')}
       ORDER BY p.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.status(200).json({
      success: true,
      data: dataResult.rows,
      pagination: { page, limit, total: parseInt(countResult.rows[0].count, 10) }
    });
  } catch (error) {
    console.error('Erreur getPaiements:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET dossier d'admission par code de paiement (guichet caisse) ─────────
exports.rechercherDossierAdmissionParCode = async (req, res) => {
  try {
    const { code } = req.query;
    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, message: 'Code de paiement requis.' });
    }

    const result = await db.query(
      `SELECT e.id AS etudiant_id, e.standing, e.code_paiement, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
              e.valide_scolarite,
              f.nom AS filiere_nom, n.libelle AS niveau_libelle, a.annee,
              s.montant_scolarite
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       LEFT JOIN anneeacademique a ON a.id = e.annee_academique_id
       LEFT JOIN scolarite s ON s.id = e.scolarite_id
       WHERE e.code_paiement = $1`,
      [code.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aucun dossier trouvé pour ce code.' });
    }
    const dossier = result.rows[0];
    if (dossier.standing === 'Inscrit') {
      return res.status(409).json({ success: false, code: 'DEJA_PAYE', message: 'Ce dossier a déjà été payé et finalisé.' });
    }
    if (dossier.valide_scolarite === false) {
      return res.status(409).json({ success: false, code: 'NON_VALIDE_SCOLARITE', message: 'Ce dossier doit d\'abord être validé par le Service de la Scolarité.' });
    }

    res.status(200).json({ success: true, data: { ...dossier, montant_annuel_nouveau: dossier.montant_scolarite } });
  } catch (error) {
    console.error('Erreur rechercherDossierAdmissionParCode:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST valider le paiement d'une admission (caisse) ──────────────────────
// Miroir de validerPaiementReinscription pour la nouvelle admission : c'est cette validation,
// et elle seule, qui rend l'inscription officielle (standing → 'Inscrit', classe/groupe affectés).
exports.validerPaiementAdmission = async (req, res) => {
  const client = await db.connect();
  try {
    const { code } = req.params;
    const { montant, methode, pec_institutionnelle, reference_pec } = req.body;

    if (!pec_institutionnelle) {
      if (!montant || isNaN(parseFloat(montant)) || parseFloat(montant) <= 0) {
        return res.status(400).json({ success: false, message: 'Montant du paiement invalide.' });
      }
      if (!methode || !METHODES_VALIDES.includes(methode)) {
        return res.status(400).json({ success: false, message: `Méthode de paiement invalide. Valeurs acceptées : ${METHODES_VALIDES.join(', ')}.` });
      }
    } else if (!reference_pec || !reference_pec.trim()) {
      return res.status(400).json({ success: false, message: 'La référence de la prise en charge institutionnelle est obligatoire.' });
    }

    await client.query('BEGIN');

    const session = await getSessionOuverte(client, req.user.id, req.user.departement_id);
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'CAISSE_FERMEE', message: 'Ouvrez votre caisse avant d\'encaisser un paiement.' });
    }

    const etudiantResult = await client.query(
      `SELECT e.*, f.nom AS filiere_nom, f.sigle AS filiere_sigle, tf.libelle AS type_filiere,
              n.libelle AS niveau_libelle, c.type_parcours AS cursus, s.montant_scolarite
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN typefiliere tf ON tf.id = f.type_filiere_id
       JOIN niveau n ON n.id = e.niveau_id
       LEFT JOIN curcus c ON c.id = e.curcus_id
       LEFT JOIN scolarite s ON s.id = e.scolarite_id
       WHERE e.code_paiement = $1
       FOR UPDATE OF e`,
      [code.trim().toUpperCase()]
    );
    if (etudiantResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Aucun dossier trouvé pour ce code.' });
    }
    const etudiant = etudiantResult.rows[0];
    if (etudiant.standing === 'Inscrit') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'DEJA_PAYE', message: 'Ce dossier a déjà été payé et finalisé.' });
    }
    if (etudiant.valide_scolarite === false) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'NON_VALIDE_SCOLARITE', message: 'Ce dossier doit d\'abord être validé par le Service de la Scolarité.' });
    }

    const montantScolarite = parseFloat(etudiant.montant_scolarite || 0);

    if (pec_institutionnelle) {
      try {
        await creerPecInstitutionnelle(client, {
          etudiantId: etudiant.id,
          montantScolarite,
          referencePec: reference_pec.trim(),
          userId: req.user.id,
          caisseId: session.caisse_id,
          anneeAcademiqueId: etudiant.annee_academique_id,
        });
      } catch (pecErr) {
        await client.query('ROLLBACK');
        if (pecErr.code === 'PEC_DEJA_EXISTANTE') {
          return res.status(409).json({ success: false, code: pecErr.code, message: pecErr.message });
        }
        throw pecErr;
      }
    }

    const montantPaye = pec_institutionnelle ? 0 : parseFloat(montant);
    // PEC institutionnelle 100 % : l'étudiant est traité comme devant 0 F dès l'initiation
    // (pas seulement "rien versé pour l'instant" — la formule generale montantScolarite -
    // montantPaye donnerait ici le montant total, ce qui serait faux). scolarite_restante ne
    // redevient positif qu'après la décision du Fondateur (validerPEC, cf. Chantier 2).
    const scolariteRestante = pec_institutionnelle ? 0 : (montantScolarite - montantPaye);
    if (scolariteRestante < 0) {
      throw new Error('Le montant payé ne peut pas dépasser le montant total de la scolarité.');
    }
    const statutEtudiantScolarite = Math.abs(scolariteRestante) < 0.01 ? 'SOLDE' : 'NON_SOLDE';

    await client.query(
      `UPDATE scolarite SET scolarite_verse = $1, scolarite_restante = $2, statut_etudiant = $3 WHERE id = $4`,
      [montantPaye, scolariteRestante, statutEtudiantScolarite, etudiant.scolarite_id]
    );

    // Chantier 6 : affectation à la classe, groupe pédagogique réel non attribué automatiquement.
    // Chantier 11 (sous-phase 2) : le groupe technique "primaire" de la classe, lui, est
    // réaffecté automatiquement — uniquement si la classe relève de la nouvelle architecture
    // (groupePrimaireId reste null pour toute classe déjà existante avant ce chantier).
    const { groupePrimaireId } = await affecterClasse(client, {
      etudiantId: etudiant.id,
      filiereNom: etudiant.filiere_nom,
      filiereSigle: etudiant.filiere_sigle,
      niveauLibelle: etudiant.niveau_libelle,
      cursus: etudiant.cursus,
      curcusId: etudiant.curcus_id,
      anneeAcademiqueId: etudiant.annee_academique_id,
      filiereId: etudiant.id_filiere,
      niveauId: etudiant.niveau_id,
    });
    const groupeId = groupePrimaireId;

    if (groupePrimaireId) {
      await client.query(`UPDATE etudiant SET standing = 'Inscrit', groupe_id = $1 WHERE id = $2`, [groupePrimaireId, etudiant.id]);
    } else {
      await client.query(`UPDATE etudiant SET standing = 'Inscrit' WHERE id = $1`, [etudiant.id]);
    }

    // Historique : première trace du parcours de l'étudiant (couvre aussi la toute première
    // année, que la table réinscription ne peut pas capturer).
    await client.query(
      `INSERT INTO historique_inscription (
         etudiant_id, type_evenement, annee_academique_id, niveau_id, id_filiere, groupe_id,
         statut_scolaire, montant_scolarite, scolarite_verse, scolarite_restante, statut_paiement, valide_par, curcus_id
       ) VALUES ($1, 'admission', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [etudiant.id, etudiant.annee_academique_id, etudiant.niveau_id, etudiant.id_filiere, groupeId,
       etudiant.statut_scolaire, montantScolarite, montantPaye, scolariteRestante, statutEtudiantScolarite, req.user?.id || null, etudiant.curcus_id ?? null]
    );

    const datePaiement = new Date();
    const numeroRecu = `RECU-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const recuResult = await client.query(
      `INSERT INTO recu (numero_recu, date_emission, montant, emetteur) VALUES ($1, $2, $3, $4) RETURNING id`,
      [numeroRecu, datePaiement, montantPaye, req.user?.code || null]
    );

    // Trace de l'opération à la Caisse même à 0 FCFA (PEC institutionnelle) : type_frais dédié
    // ('pec_institutionnelle') réutilisant le mécanisme déjà existant (Supervision des caisses,
    // Bilan des dépenses regroupent déjà dynamiquement par type_frais) — un montant à 0 n'inflate
    // jamais un total encaissé, cette opération n'est donc jamais comptabilisée comme une recette.
    const paiementResult = await client.query(
      `INSERT INTO paiement (montant, date_paiement, methode, effectue_par, etudiant_id, recu_id, annee_academique_id, session_caisse_id, caisse_id, type_frais)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [montantPaye, datePaiement, pec_institutionnelle ? 'Prise en charge institutionnelle' : methode, req.user?.id || null, etudiant.id, recuResult.rows[0].id, etudiant.annee_academique_id, session.id, session.caisse_id, pec_institutionnelle ? 'pec_institutionnelle' : null]
    );

    // Une seule entrée kit par étudiant (comme dans createPaiement) — non déposé par défaut,
    // le caissier n'a pas de case "kit" dans ce parcours minimal ; ajustable plus tard sur le dossier.
    // annee_academique_id tracé pour permettre à getRecuData de savoir à quelle campagne ce kit
    // se rattache (utilisé notamment pour la suspension du module par année, cf. kitCampagne.service.js).
    const hasKit = await client.query('SELECT 1 FROM kit WHERE etudiant_id = $1', [etudiant.id]);
    if (hasKit.rows.length === 0) {
      await client.query(
        `INSERT INTO kit (etudiant_id, montant, deposer, date_enregistrement, annee_academique_id) VALUES ($1, 0, false, $2, $3)`,
        [etudiant.id, datePaiement, etudiant.annee_academique_id]
      );
    }

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: pec_institutionnelle
        ? 'Prise en charge institutionnelle initiée : inscription finalisée, en attente de confirmation du Fondateur.'
        : 'Paiement validé : inscription finalisée.',
      data: {
        etudiant_id: etudiant.id,
        paiement_id: paiementResult.rows[0].id,
        recu_id: recuResult.rows[0].id,
        numero_recu: numeroRecu,
        scolarite_verse: montantPaye,
        scolarite_restante: scolariteRestante,
        statut_etudiant: statutEtudiantScolarite,
        pec_institutionnelle: !!pec_institutionnelle,
        reference_pec: pec_institutionnelle ? reference_pec.trim() : undefined
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur validerPaiementAdmission:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.', details: error.message });
  } finally {
    client.release();
  }
};

// ─── Recherche/validation unifiées (dispatch par préfixe de code) ──────────
// Un seul champ "code de paiement" côté caisse pour inscription (AD-) et réinscription (RI-) —
// le caissier n'a pas à savoir à l'avance de quel processus il s'agit.
exports.rechercherDossierParCodeUnifie = async (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if (code.startsWith('AD-')) {
    return exports.rechercherDossierAdmissionParCode(req, res);
  }
  return exports.rechercherDossierParCode(req, res);
};

// ─── GET dossiers en attente de paiement (admissions + réinscriptions fusionnées) ──
// Remplace l'ancienne page Scolarité "Inscriptions en attente" — la caisse est désormais le
// seul endroit où consulter ces dossiers, chercher un étudiant, voir sa fiche et encaisser.
exports.getInscriptionsEnAttente = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    const { anneeAcademiqueId, search } = req.query;
    if (!anneeAcademiqueId) {
      return res.status(400).json({ success: false, message: "L'ID de l'année académique est requis", code: 'ACADEMIC_YEAR_REQUIRED' });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = (page - 1) * limit;

    const params = [siteId, anneeAcademiqueId];
    let searchClause = '';
    if (search) {
      searchClause = `AND (nom ILIKE $${params.length + 1} OR prenoms ILIKE $${params.length + 1} OR matricule_iipea ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (e.site_id) existant,
    // appliqué aux deux branches de l'UNION (admission et réinscription).
    let ecoleCond = '';
    if (ecoleId !== null) {
      ecoleCond = `AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $${params.length + 1})`;
      params.push(ecoleId);
    }

    const baseQuery = `
      SELECT * FROM (
        SELECT 'admission' AS type, e.id AS etudiant_id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
               f.nom AS filiere, n.libelle AS niveau, e.code_paiement, e.date_inscription AS date_dossier,
               e.id AS dossier_id
        FROM etudiant e
        JOIN filiere f ON f.id = e.id_filiere
        JOIN niveau n ON n.id = e.niveau_id
        WHERE e.standing = 'en attente' AND e.site_id = $1 AND e.annee_academique_id = $2 ${ecoleCond}

        UNION ALL

        SELECT 'reinscription' AS type, e.id AS etudiant_id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
               f.nom AS filiere, n.libelle AS niveau, r.code_paiement, r.created_at AS date_dossier,
               r.id AS dossier_id
        FROM reinscription r
        JOIN etudiant e ON e.id = r.etudiant_id
        JOIN niveau n ON n.id = r.niveau_retenu_id
        LEFT JOIN filiere f ON f.id = r.id_filiere_retenu
        WHERE r.statut = 'en_attente_paiement' AND e.site_id = $1 AND r.anneeacademique_id = $2 ${ecoleCond}
      ) dossiers
      WHERE 1=1 ${searchClause}
    `;

    const countResult = await db.query(`SELECT COUNT(*) FROM (${baseQuery}) c`, params);
    const dataResult = await db.query(
      `${baseQuery} ORDER BY date_dossier DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.status(200).json({
      success: true,
      data: dataResult.rows,
      pagination: { page, limit, total: parseInt(countResult.rows[0].count, 10) }
    });
  } catch (error) {
    console.error('Erreur getInscriptionsEnAttente:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

exports.validerPaiementUnifie = async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();
  if (code.startsWith('AD-')) {
    return exports.validerPaiementAdmission(req, res);
  }
  return exports.validerPaiementReinscription(req, res);
};

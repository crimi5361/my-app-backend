const db = require('../config/db.config');
const { affecterClasseEtGroupe } = require('../services/classeGroupe.service');

const METHODES_VALIDES = ['Espèces', 'Mobile Money', 'Orange Money', 'Wave'];

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
    const { montant_compte } = req.body;
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
      `UPDATE session_caisse SET date_fermeture = now(), montant_fermeture = $1, statut = 'FERMEE' WHERE id = $2`,
      [montant_compte, id]
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

// Construit le rapport de clôture (totaux + répartition par méthode) d'une session donnée.
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

  const totauxResult = await db.query(
    `SELECT COUNT(*) AS nb_paiements, COALESCE(SUM(montant), 0) AS total_encaisse
     FROM paiement WHERE session_caisse_id = $1`,
    [sessionId]
  );
  const parMethodeResult = await db.query(
    `SELECT methode, COUNT(*) AS nb, COALESCE(SUM(montant), 0) AS total
     FROM paiement WHERE session_caisse_id = $1 GROUP BY methode ORDER BY methode`,
    [sessionId]
  );

  return {
    session,
    nb_paiements: parseInt(totauxResult.rows[0].nb_paiements, 10),
    total_encaisse: parseFloat(totauxResult.rows[0].total_encaisse),
    repartition_methode: parMethodeResult.rows.map(r => ({ methode: r.methode, nb: parseInt(r.nb, 10), total: parseFloat(r.total) })),
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
    const { montant, methode } = req.body;

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
             decision_academique, moyenne_annuelle, reinscription_id, valide_par
           ) VALUES ($1, 'cloture', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [etudiant.id, etudiant.annee_academique_id, etudiant.niveau_id, etudiant.id_filiere, etudiant.groupe_id,
           etudiant.statut_scolaire, ancienneScolarite?.montant_scolarite ?? null, ancienneScolarite?.scolarite_verse ?? null,
           ancienneScolarite?.scolarite_restante ?? null, ancienneScolarite?.statut_etudiant ?? null,
           dossier.decision_academique, dossier.moyenne_annuelle, dossier.id, req.user?.id || null]
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
    const montantPaye = parseFloat(montant);
    const scolariteRestante = montantScolarite - montantPaye;
    if (scolariteRestante < 0) {
      throw new Error('Le montant payé ne peut pas dépasser le montant total de la scolarité.');
    }
    const statutEtudiantScolarite = Math.abs(scolariteRestante) < 0.01 ? 'SOLDE' : 'NON_SOLDE';

    const scolariteResult = await client.query(
      `INSERT INTO scolarite (montant_scolarite, scolarite_verse, scolarite_restante, statut_etudiant)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [montantScolarite, montantPaye, scolariteRestante, statutEtudiantScolarite]
    );

    await client.query(
      `UPDATE etudiant SET
         niveau_id = $1, annee_academique_id = $2, scolarite_id = $3,
         id_filiere = $4, statut_scolaire = $5, standing = 'Inscrit',
         curcus_id = COALESCE($6, curcus_id)
       WHERE id = $7`,
      [dossier.niveau_retenu_id, dossier.anneeacademique_id, scolariteResult.rows[0].id,
       dossier.id_filiere_retenu, dossier.statut_scolaire_retenu, dossier.curcus_id, dossier.etudiant_id]
    );

    // Filet de sécurité pour l'avenir : aucun code n'écrit encore dans inscription_annuelle
    // aujourd'hui, mais si une ligne existait déjà pour cette année, son parcours doit rester
    // cohérent avec le choix fait ici plutôt que de rester orpheline.
    if (dossier.curcus_id) {
      await client.query(
        `UPDATE inscription_annuelle SET curcus_id = $1 WHERE etudiant_id = $2 AND annee_academique_id = $3`,
        [dossier.curcus_id, dossier.etudiant_id, dossier.anneeacademique_id]
      );
    }

    // Affectation classe/groupe : toujours celle de la NOUVELLE classe (nouveau niveau/année),
    // jamais l'ancien groupe de l'étudiant.
    const { groupeId } = await affecterClasseEtGroupe(client, {
      etudiantId: dossier.etudiant_id,
      filiereNom: infos.filiere_nom,
      filiereSigle: infos.filiere_sigle,
      niveauLibelle: infos.niveau_libelle,
      cursus: infos.cursus,
      curcusId: infos.curcus_id_resolu,
      typeFiliere: infos.type_filiere,
      anneeAcademiqueId: dossier.anneeacademique_id,
      filiereId: dossier.id_filiere_retenu,
      niveauId: dossier.niveau_retenu_id,
    });

    // Historique : trace permanente de ce cycle, consultable même une fois que l'état "courant"
    // de l'étudiant aura été réécrit par une réinscription future (bug #9 du tour précédent).
    await client.query(
      `INSERT INTO historique_inscription (
         etudiant_id, type_evenement, annee_academique_id, niveau_id, id_filiere, groupe_id,
         statut_scolaire, montant_scolarite, scolarite_verse, scolarite_restante, statut_paiement,
         decision_academique, moyenne_annuelle, reinscription_id, valide_par
       ) VALUES ($1, 'reinscription', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [dossier.etudiant_id, dossier.anneeacademique_id, dossier.niveau_retenu_id, dossier.id_filiere_retenu, groupeId,
       dossier.statut_scolaire_retenu, montantScolarite, montantPaye, scolariteRestante, statutEtudiantScolarite,
       dossier.decision_academique, dossier.moyenne_annuelle, dossier.id, req.user?.id || null]
    );

    const datePaiement = new Date();
    const numeroRecu = `RECU-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const recuResult = await client.query(
      `INSERT INTO recu (numero_recu, date_emission, montant, emetteur) VALUES ($1, $2, $3, $4) RETURNING id`,
      [numeroRecu, datePaiement, montant, req.user?.code || null]
    );

    const paiementResult = await client.query(
      `INSERT INTO paiement (montant, date_paiement, methode, effectue_par, etudiant_id, recu_id, annee_academique_id, session_caisse_id, caisse_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [montant, datePaiement, methode, req.user?.id || null, dossier.etudiant_id, recuResult.rows[0].id, dossier.anneeacademique_id, session.id, session.caisse_id]
    );

    await client.query(
      `UPDATE reinscription SET statut = 'inscrit', updated_at = now() WHERE id = $1`,
      [dossier.id]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Paiement validé : réinscription finalisée.',
      data: {
        etudiant_id: dossier.etudiant_id,
        paiement_id: paiementResult.rows[0].id,
        recu_id: recuResult.rows[0].id,
        numero_recu: numeroRecu,
        scolarite_verse: montantPaye,
        scolarite_restante: scolariteRestante,
        statut_etudiant: statutEtudiantScolarite
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
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }

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
       ORDER BY e.nom, e.prenoms
       LIMIT 20`,
      [siteId, `%${q.trim()}%`]
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

    const etudiantResult = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url, e.standing,
              e.annee_academique_id, e.scolarite_id
       FROM etudiant e
       WHERE e.id = $1 AND e.site_id = $2`,
      [id, siteId]
    );
    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];
    const annees = [];

    if (etudiant.scolarite_id) {
      const courant = await db.query(
        `SELECT e.annee_academique_id, aa.annee, n.libelle AS niveau, f.nom AS filiere,
                s.montant_scolarite, s.scolarite_verse, s.scolarite_restante,
                s.statut_etudiant AS statut_paiement, e.statut_scolaire, NULL::text AS type_evenement
         FROM etudiant e
         JOIN scolarite s ON s.id = e.scolarite_id
         LEFT JOIN anneeacademique aa ON aa.id = e.annee_academique_id
         LEFT JOIN niveau n ON n.id = e.niveau_id
         LEFT JOIN filiere f ON f.id = e.id_filiere
         WHERE e.id = $1`,
        [id]
      );
      if (courant.rows.length > 0) {
        annees.push({ ...courant.rows[0], source: 'current', is_current: true });
      }
    }

    const passees = await db.query(
      `SELECT DISTINCT ON (hi.annee_academique_id)
              hi.annee_academique_id, aa.annee, n.libelle AS niveau, f.nom AS filiere,
              hi.montant_scolarite, hi.scolarite_verse, hi.scolarite_restante,
              hi.statut_paiement, hi.statut_scolaire, hi.type_evenement
       FROM historique_inscription hi
       LEFT JOIN anneeacademique aa ON aa.id = hi.annee_academique_id
       LEFT JOIN niveau n ON n.id = hi.niveau_id
       LEFT JOIN filiere f ON f.id = hi.id_filiere
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
    const anneeId = parseInt(anneeAcademiqueId, 10);

    const etudiantResult = await db.query(
      `SELECT id, annee_academique_id, scolarite_id FROM etudiant WHERE id = $1 AND site_id = $2`,
      [id, siteId]
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

    const etudiantResult = await client.query(
      `SELECT id, annee_academique_id, scolarite_id FROM etudiant WHERE id = $1 AND site_id = $2 FOR UPDATE`,
      [id, req.user.departement_id]
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
         (SELECT COUNT(*) FROM prise_en_charge WHERE statut = 'en_attente') AS pec_en_attente`
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

// ─── GET liste des paiements avec filtres (paiements du jour / historique) ─
exports.getPaiements = async (req, res) => {
  try {
    const siteId = req.user.departement_id;
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
    const { montant, methode } = req.body;

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
    const montantPaye = parseFloat(montant);
    const scolariteRestante = montantScolarite - montantPaye;
    if (scolariteRestante < 0) {
      throw new Error('Le montant payé ne peut pas dépasser le montant total de la scolarité.');
    }
    const statutEtudiantScolarite = Math.abs(scolariteRestante) < 0.01 ? 'SOLDE' : 'NON_SOLDE';

    await client.query(
      `UPDATE scolarite SET scolarite_verse = $1, scolarite_restante = $2, statut_etudiant = $3 WHERE id = $4`,
      [montantPaye, scolariteRestante, statutEtudiantScolarite, etudiant.scolarite_id]
    );

    const { groupeId } = await affecterClasseEtGroupe(client, {
      etudiantId: etudiant.id,
      filiereNom: etudiant.filiere_nom,
      filiereSigle: etudiant.filiere_sigle,
      niveauLibelle: etudiant.niveau_libelle,
      cursus: etudiant.cursus,
      curcusId: etudiant.curcus_id,
      typeFiliere: etudiant.type_filiere,
      anneeAcademiqueId: etudiant.annee_academique_id,
      filiereId: etudiant.id_filiere,
      niveauId: etudiant.niveau_id,
    });

    await client.query(`UPDATE etudiant SET standing = 'Inscrit' WHERE id = $1`, [etudiant.id]);

    // Historique : première trace du parcours de l'étudiant (couvre aussi la toute première
    // année, que la table réinscription ne peut pas capturer).
    await client.query(
      `INSERT INTO historique_inscription (
         etudiant_id, type_evenement, annee_academique_id, niveau_id, id_filiere, groupe_id,
         statut_scolaire, montant_scolarite, scolarite_verse, scolarite_restante, statut_paiement, valide_par
       ) VALUES ($1, 'admission', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [etudiant.id, etudiant.annee_academique_id, etudiant.niveau_id, etudiant.id_filiere, groupeId,
       etudiant.statut_scolaire, montantScolarite, montantPaye, scolariteRestante, statutEtudiantScolarite, req.user?.id || null]
    );

    const datePaiement = new Date();
    const numeroRecu = `RECU-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const recuResult = await client.query(
      `INSERT INTO recu (numero_recu, date_emission, montant, emetteur) VALUES ($1, $2, $3, $4) RETURNING id`,
      [numeroRecu, datePaiement, montant, req.user?.code || null]
    );

    const paiementResult = await client.query(
      `INSERT INTO paiement (montant, date_paiement, methode, effectue_par, etudiant_id, recu_id, annee_academique_id, session_caisse_id, caisse_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [montant, datePaiement, methode, req.user?.id || null, etudiant.id, recuResult.rows[0].id, etudiant.annee_academique_id, session.id, session.caisse_id]
    );

    // Une seule entrée kit par étudiant (comme dans createPaiement) — non déposé par défaut,
    // le caissier n'a pas de case "kit" dans ce parcours minimal ; ajustable plus tard sur le dossier.
    const hasKit = await client.query('SELECT 1 FROM kit WHERE etudiant_id = $1', [etudiant.id]);
    if (hasKit.rows.length === 0) {
      await client.query(
        `INSERT INTO kit (etudiant_id, montant, deposer, date_enregistrement) VALUES ($1, 0, false, $2)`,
        [etudiant.id, datePaiement]
      );
    }

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Paiement validé : inscription finalisée.',
      data: {
        etudiant_id: etudiant.id,
        paiement_id: paiementResult.rows[0].id,
        recu_id: recuResult.rows[0].id,
        numero_recu: numeroRecu,
        scolarite_verse: montantPaye,
        scolarite_restante: scolariteRestante,
        statut_etudiant: statutEtudiantScolarite
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

    const baseQuery = `
      SELECT * FROM (
        SELECT 'admission' AS type, e.id AS etudiant_id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
               f.nom AS filiere, n.libelle AS niveau, e.code_paiement, e.date_inscription AS date_dossier,
               e.id AS dossier_id
        FROM etudiant e
        JOIN filiere f ON f.id = e.id_filiere
        JOIN niveau n ON n.id = e.niveau_id
        WHERE e.standing = 'en attente' AND e.site_id = $1 AND e.annee_academique_id = $2

        UNION ALL

        SELECT 'reinscription' AS type, e.id AS etudiant_id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
               f.nom AS filiere, n.libelle AS niveau, r.code_paiement, r.created_at AS date_dossier,
               r.id AS dossier_id
        FROM reinscription r
        JOIN etudiant e ON e.id = r.etudiant_id
        JOIN niveau n ON n.id = r.niveau_retenu_id
        LEFT JOIN filiere f ON f.id = r.id_filiere_retenu
        WHERE r.statut = 'en_attente_paiement' AND e.site_id = $1 AND r.anneeacademique_id = $2
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

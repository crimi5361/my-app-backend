// controllers/equivalence.controller.js
// Module Équivalence — voir le document de conception de référence pour le contexte complet
// (workflow, règles métier, machine à états). Phase 2 : dépôt, consultation, cycle de
// complément, statut par document. Phase 3 : décision (prendre en charge, demander un
// complément, valider, refuser, annuler) + service e-mail.
const db = require('../config/db.config');
const {
  estNiveauEligibleEquivalence,
  resoudreDocumentsRequis,
  validerDocumentsFournis,
} = require('../config/equivalenceDocuments.config');
const { genererCodeCandidat, avecRetryCodeUnique } = require('../services/codePaiement.service');
const { saveDocument } = require('../services/documentStorage.service');
const { enregistrerEvenementHistorique } = require('../services/equivalenceHistorique.service');
const { resoudreFormationEtParcours } = require('../services/parcoursProfessionnel.service');
const { generateMatriculeIIPEA, generateCodeUnique } = require('./etudiant.controller');
const emailService = require('../services/email.service');

const API_URL = process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`;

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

const getNiveauInfo = async (client, niveauId) => {
  const result = await client.query(
    `SELECT n.id, n.libelle, n.filiere_id, f.nom AS filiere_nom, f.sigle AS filiere_sigle,
            d.nom AS departement_nom, ec.nom AS ecole_nom
     FROM niveau n
     JOIN filiere f ON f.id = n.filiere_id
     LEFT JOIN departement d ON d.id = f.departement_id
     LEFT JOIN ecole ec ON ec.id = d.ecole_id
     WHERE n.id = $1`,
    [niveauId]
  );
  return result.rows[0] || null;
};

// Résout, pour un niveau donné, la liste des documents requis (config) enrichie des libellés
// humains lus dans type_document (une seule requête, jamais de libellé dupliqué en dur ici).
const resoudreDocumentsRequisAvecLibelles = async (client, niveauLibelle) => {
  const structure = resoudreDocumentsRequis(niveauLibelle);
  const tousCodes = structure.flatMap((e) => (e.groupe ? e.options : [e.code]));
  const libellesResult = await client.query(
    `SELECT id, code, libelle FROM type_document WHERE code = ANY($1::varchar[])`,
    [tousCodes]
  );
  const parCode = new Map(libellesResult.rows.map((r) => [r.code, r]));
  return structure.map((entree) => {
    if (entree.groupe) {
      return {
        groupe: entree.groupe,
        obligatoire: entree.obligatoire,
        options: entree.options.map((code) => ({ code, ...parCode.get(code) })),
      };
    }
    return { code: entree.code, obligatoire: entree.obligatoire, ...parCode.get(entree.code) };
  });
};

const resoudreAnneeEnCoursPourSite = async (client, siteId) => {
  const result = await client.query(
    `SELECT a.id FROM anneeacademique a
     JOIN anneeacademique_site s ON s.anneeacademique_id = a.id
     WHERE s.site_id = $1 AND s.etat = 'en cour'
     LIMIT 1`,
    [siteId]
  );
  return result.rows[0]?.id || null;
};

// ── GET /api/equivalence/documents-requis?niveau_id=X [public] ─────────────────────────────
exports.getDocumentsRequis = async (req, res) => {
  try {
    const { niveau_id } = req.query;
    if (!niveau_id) return res.status(400).json({ success: false, message: 'niveau_id est requis.' });

    const niveau = await getNiveauInfo(db, niveau_id);
    if (!niveau) return res.status(404).json({ success: false, message: 'Niveau introuvable.' });

    if (!estNiveauEligibleEquivalence(niveau.libelle)) {
      return res.status(400).json({
        success: false,
        message: `Le niveau "${niveau.libelle}" n'est pas éligible à une demande d'équivalence.`,
        code: 'NIVEAU_NON_ELIGIBLE',
      });
    }

    const documents = await resoudreDocumentsRequisAvecLibelles(db, niveau.libelle);
    return res.status(200).json({ success: true, niveau: { id: niveau.id, libelle: niveau.libelle }, documents });
  } catch (error) {
    console.error('Erreur getDocumentsRequis:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ── POST /api/equivalence/deposer [public, multipart] ───────────────────────────────────────
exports.deposerDemande = async (req, res) => {
  const client = await db.connect();
  try {
    const b = req.body;
    const requis = ['nom', 'prenoms', 'sexe', 'date_naissance', 'nationalite', 'telephone', 'email',
      'id_filiere', 'niveau_id', 'site_id'];
    const manquants = requis.filter((champ) => !b[champ]);
    if (manquants.length > 0) {
      return res.status(400).json({ success: false, message: 'Champs obligatoires manquants.', manquants });
    }
    const engagementAccepte = b.engagement_accepte === true || b.engagement_accepte === 'true';
    if (!engagementAccepte) {
      return res.status(400).json({ success: false, message: "L'engagement doit être accepté." });
    }

    await client.query('BEGIN');

    // Règle métier 1.7 : l'année académique n'est JAMAIS acceptée du client — résolue serveur
    // à partir du site choisi par le candidat.
    const anneeAcademiqueId = await resoudreAnneeEnCoursPourSite(client, b.site_id);
    if (!anneeAcademiqueId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: "Aucune année académique n'est actuellement ouverte pour cet établissement.",
        code: 'AUCUNE_ANNEE_OUVERTE',
      });
    }

    // Règle métier 1.2 : niveau éligible à l'équivalence uniquement.
    const niveau = await getNiveauInfo(client, b.niveau_id);
    if (!niveau || String(niveau.filiere_id) !== String(b.id_filiere)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Niveau invalide pour cette filière.' });
    }
    if (!estNiveauEligibleEquivalence(niveau.libelle)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: `Le niveau "${niveau.libelle}" n'est pas éligible à une demande d'équivalence.`,
        code: 'NIVEAU_NON_ELIGIBLE',
      });
    }

    // Règle métier 1.4/1.5 : une seule demande par candidat et par année (vérification
    // applicative en plus de la contrainte UNIQUE en base, pour un message clair).
    const doublon = await client.query(
      `SELECT id FROM demande_equivalence WHERE email = $1 AND annee_academique_id = $2`,
      [b.email, anneeAcademiqueId]
    );
    if (doublon.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'Une demande existe déjà pour cet email sur cette année académique.',
        code: 'DEMANDE_DEJA_EXISTANTE',
      });
    }

    // Revalidation serveur des pièces obligatoires — jamais confiance au seul frontend/portail.
    const fichiers = req.files || [];
    const codesFournis = new Set(fichiers.map((f) => f.fieldname.replace(/^doc_/, '')));
    const manques = validerDocumentsFournis(niveau.libelle, codesFournis);
    if (manques.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Pièces justificatives obligatoires manquantes.',
        manques,
      });
    }

    const codeSuivi = await avecRetryCodeUnique('EQS', async (candidat) => {
      const result = await client.query(
        `INSERT INTO demande_equivalence (
           nom, prenoms, sexe, date_naissance, lieu_naissance, nationalite, telephone, email, adresse,
           contact_parent, nom_parent_1, adresse_parent_1, contact_parent_2, nom_parent_2, adresse_parent_2,
           etablissement_origine, diplome_obtenu, annee_obtention_diplome,
           id_filiere, niveau_id, site_id, annee_academique_id, code_suivi, curcus_id, engagement_accepte
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         RETURNING id, code_suivi`,
        [
          b.nom.toUpperCase(), b.prenoms.toUpperCase(), b.sexe, b.date_naissance, b.lieu_naissance || null,
          b.nationalite, b.telephone, b.email, b.adresse || null,
          b.contact_parent || null, b.nom_parent_1 || null, b.adresse_parent_1 || null,
          b.contact_parent_2 || null, b.nom_parent_2 || null, b.adresse_parent_2 || null,
          b.etablissement_origine || null, b.diplome_obtenu || null, b.annee_obtention_diplome || null,
          b.id_filiere, b.niveau_id, b.site_id, anneeAcademiqueId, candidat, b.curcus_id || null, true,
        ]
      );
      return result.rows[0];
    });

    const demandeId = codeSuivi.id;

    // Pièces jointes — même hiérarchie de stockage que l'admission (saveDocument), sans
    // etudiant existant : nomDossierEtudiant utilise code_suivi à la place du matricule.
    const typeDocResult = await client.query(
      `SELECT id, code FROM type_document WHERE code = ANY($1::varchar[])`,
      [fichiers.map((f) => f.fieldname.replace(/^doc_/, ''))]
    );
    const typeDocParCode = new Map(typeDocResult.rows.map((r) => [r.code, r.id]));

    for (const fichier of fichiers) {
      const code = fichier.fieldname.replace(/^doc_/, '');
      const typeDocumentId = typeDocParCode.get(code);
      if (!typeDocumentId) continue; // champ inattendu, ignoré silencieusement

      const hierarchy = {
        ecole: niveau.ecole_nom,
        departement: niveau.departement_nom,
        filiere: niveau.filiere_nom,
        niveau: niveau.libelle,
        nomDossierEtudiant: `${b.nom.toUpperCase()} ${b.prenoms.toUpperCase()} - ${codeSuivi.code_suivi}`,
        typeDocumentCode: code,
      };
      const saved = await saveDocument({ file: fichier, hierarchy });

      await client.query(
        `INSERT INTO document_equivalence (demande_equivalence_id, type_document_id, fichier_path, storage_provider, drive_file_id, drive_folder_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [demandeId, typeDocumentId, saved.url, saved.provider, saved.driveFileId || null, saved.driveFolderId || null]
      );
    }

    await enregistrerEvenementHistorique(client, {
      demandeId,
      type: 'creation',
      statutApres: 'en_attente',
      detail: `Demande déposée avec ${fichiers.length} pièce(s) jointe(s).`,
    });

    await client.query('COMMIT');

    // E-mail d'accusé de réception — best-effort, après le commit, jamais bloquant pour la
    // demande déjà enregistrée (voir document de conception §5.4/§8).
    const templateAccuse = emailService.templateAccuseReception({
      prenoms: b.prenoms.toUpperCase(), nom: b.nom.toUpperCase(), codeSuivi: codeSuivi.code_suivi,
    });
    const envoiAccuse = await emailService.envoyerEmail({ to: b.email, ...templateAccuse });
    await enregistrerEvenementHistorique(db, {
      demandeId,
      type: envoiAccuse.success ? 'mail_envoye' : 'mail_echec',
      detail: envoiAccuse.success ? 'Accusé de réception envoyé.' : envoiAccuse.error,
    });

    return res.status(201).json({
      success: true,
      message: 'Votre demande d\'équivalence a bien été enregistrée. Elle sera étudiée par notre commission. Une réponse vous sera transmise par email sous 7 jours maximum.',
      data: { id: demandeId, code_suivi: codeSuivi.code_suivi },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur deposerDemande:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.', details: error.message });
  } finally {
    client.release();
  }
};

// ── GET /api/equivalence/suivi/:code_suivi [public] ─────────────────────────────────────────
exports.getSuiviParCode = async (req, res) => {
  try {
    const { code_suivi } = req.params;
    const demandeResult = await db.query(
      `SELECT de.id, de.nom, de.prenoms, de.statut, de.motif_complement, de.motif_refus, de.date_demande,
              n.libelle AS niveau_libelle
       FROM demande_equivalence de
       JOIN niveau n ON n.id = de.niveau_id
       WHERE de.code_suivi = $1`,
      [code_suivi]
    );
    if (demandeResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aucune demande trouvée pour ce code de suivi.' });
    }
    const demande = demandeResult.rows[0];

    const documentsResult = await db.query(
      `SELECT DISTINCT ON (de.type_document_id) de.type_document_id, td.code, td.libelle,
              de.statut_document, de.date_upload
       FROM document_equivalence de
       JOIN type_document td ON td.id = de.type_document_id
       WHERE de.demande_equivalence_id = $1
       ORDER BY de.type_document_id, de.date_upload DESC`,
      [demande.id]
    );

    // Résolution de la liste complète des pièces attendues pour ce niveau — nécessaire pour que
    // la page "Suivre ma demande" du portail public puisse proposer le bon formulaire de
    // complément (mêmes documents qu'au dépôt initial, cf. GET /documents-requis), sans dupliquer
    // la config ici.
    const documentsRequis = await resoudreDocumentsRequisAvecLibelles(db, demande.niveau_libelle);

    return res.status(200).json({
      success: true,
      demande: {
        nom: demande.nom,
        prenoms: demande.prenoms,
        statut: demande.statut,
        motif_complement: demande.statut === 'dossier_incomplet' ? demande.motif_complement : null,
        motif_refus: demande.statut === 'refuse' ? demande.motif_refus : null,
        date_demande: demande.date_demande,
      },
      documents: documentsResult.rows,
      documents_requis: documentsRequis,
    });
  } catch (error) {
    console.error('Erreur getSuiviParCode:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ── POST /api/equivalence/suivi/:code_suivi/documents [public, multipart] ──────────────────
exports.ajouterDocumentsComplement = async (req, res) => {
  const client = await db.connect();
  try {
    const { code_suivi } = req.params;
    const demandeResult = await client.query(
      `SELECT de.id, de.statut, de.nom, de.prenoms, de.niveau_id
       FROM demande_equivalence de WHERE de.code_suivi = $1`,
      [code_suivi]
    );
    if (demandeResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aucune demande trouvée pour ce code de suivi.' });
    }
    const demande = demandeResult.rows[0];
    if (demande.statut !== 'dossier_incomplet') {
      return res.status(403).json({
        success: false,
        message: "Cette demande n'est pas en attente de complément.",
        code: 'STATUT_INVALIDE',
      });
    }

    const niveau = await getNiveauInfo(client, demande.niveau_id);
    const fichiers = req.files || [];
    if (fichiers.length === 0) {
      return res.status(400).json({ success: false, message: 'Aucun fichier fourni.' });
    }

    await client.query('BEGIN');

    const typeDocResult = await client.query(
      `SELECT id, code FROM type_document WHERE code = ANY($1::varchar[])`,
      [fichiers.map((f) => f.fieldname.replace(/^doc_/, ''))]
    );
    const typeDocParCode = new Map(typeDocResult.rows.map((r) => [r.code, r.id]));

    for (const fichier of fichiers) {
      const code = fichier.fieldname.replace(/^doc_/, '');
      const typeDocumentId = typeDocParCode.get(code);
      if (!typeDocumentId) continue;

      const dejaExistant = await client.query(
        `SELECT 1 FROM document_equivalence WHERE demande_equivalence_id = $1 AND type_document_id = $2 LIMIT 1`,
        [demande.id, typeDocumentId]
      );

      const hierarchy = {
        ecole: niveau.ecole_nom,
        departement: niveau.departement_nom,
        filiere: niveau.filiere_nom,
        niveau: niveau.libelle,
        nomDossierEtudiant: `${demande.nom} ${demande.prenoms} - ${code_suivi}`,
        typeDocumentCode: code,
      };
      const saved = await saveDocument({ file: fichier, hierarchy });

      await client.query(
        `INSERT INTO document_equivalence (demande_equivalence_id, type_document_id, fichier_path, storage_provider, drive_file_id, drive_folder_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [demande.id, typeDocumentId, saved.url, saved.provider, saved.driveFileId || null, saved.driveFolderId || null]
      );

      await enregistrerEvenementHistorique(client, {
        demandeId: demande.id,
        type: dejaExistant.rows.length > 0 ? 'document_modifie' : 'document_ajoute',
        detail: `Pièce "${code}" ${dejaExistant.rows.length > 0 ? 'remplacée' : 'ajoutée'} par le candidat.`,
      });
    }

    await client.query(
      `UPDATE demande_equivalence SET statut = 'en_etude' WHERE id = $1`,
      [demande.id]
    );
    await enregistrerEvenementHistorique(client, {
      demandeId: demande.id,
      type: 'complement_recu',
      statutAvant: 'dossier_incomplet',
      statutApres: 'en_etude',
    });

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      message: 'Votre dossier complété a bien été transmis à notre équipe.',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur ajouterDocumentsComplement:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.', details: error.message });
  } finally {
    client.release();
  }
};

// ── GET /api/equivalence [admin|scolarite] ──────────────────────────────────────────────────
exports.listerDemandes = async (req, res) => {
  try {
    const { statut, niveau_id, id_filiere, annee_academique_id, search } = req.query;
    const conditions = [];
    const params = [];

    if (statut) { params.push(statut); conditions.push(`de.statut = $${params.length}`); }
    if (niveau_id) { params.push(niveau_id); conditions.push(`de.niveau_id = $${params.length}`); }
    if (id_filiere) { params.push(id_filiere); conditions.push(`de.id_filiere = $${params.length}`); }
    if (annee_academique_id) { params.push(annee_academique_id); conditions.push(`de.annee_academique_id = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(de.nom ILIKE $${params.length} OR de.prenoms ILIKE $${params.length} OR de.email ILIKE $${params.length})`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await db.query(
      `SELECT de.id, de.nom, de.prenoms, de.telephone, de.email, de.statut,
              de.date_demande, de.date_traitement, de.traite_par,
              f.nom AS nom_filiere, n.libelle AS nom_niveau
       FROM demande_equivalence de
       JOIN filiere f ON f.id = de.id_filiere
       JOIN niveau n ON n.id = de.niveau_id
       ${whereClause}
       ORDER BY de.date_demande DESC`,
      params
    );

    return res.status(200).json({ success: true, demandes: result.rows, total: result.rows.length });
  } catch (error) {
    console.error('Erreur listerDemandes:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ── GET /api/equivalence/:id [admin|scolarite] ──────────────────────────────────────────────
exports.getDemandeById = async (req, res) => {
  try {
    const { id } = req.params;
    const demandeResult = await db.query(
      `SELECT de.*, f.nom AS nom_filiere, f.sigle AS sigle_filiere, n.libelle AS nom_niveau,
              u.nom AS agent_nom, a.annee AS annee_academique
       FROM demande_equivalence de
       JOIN filiere f ON f.id = de.id_filiere
       JOIN niveau n ON n.id = de.niveau_id
       JOIN anneeacademique a ON a.id = de.annee_academique_id
       LEFT JOIN utilisateur u ON u.id = de.traite_par
       WHERE de.id = $1`,
      [id]
    );
    if (demandeResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    }
    const demande = demandeResult.rows[0];

    // Documents réellement fournis (version courante uniquement, cf. remplacement)
    const documentsResult = await db.query(
      `SELECT DISTINCT ON (de.type_document_id) de.id, de.type_document_id, td.code, td.libelle,
              td.obligatoire, de.fichier_path, de.storage_provider, de.statut_document,
              de.commentaire_verification, de.date_upload
       FROM document_equivalence de
       JOIN type_document td ON td.id = de.type_document_id
       WHERE de.demande_equivalence_id = $1
       ORDER BY de.type_document_id, de.date_upload DESC`,
      [id]
    );
    const codesPresents = new Set(documentsResult.rows.map((d) => d.code));

    // Résolution "manquant" : diff entre la config et les documents réellement présents —
    // jamais stocké en base (document de conception §4.2).
    const requis = await resoudreDocumentsRequisAvecLibelles(db, demande.nom_niveau);
    const manquants = [];
    for (const entree of requis) {
      if (entree.groupe) {
        const satisfait = entree.options.some((o) => codesPresents.has(o.code));
        if (!satisfait) manquants.push({ groupe: entree.groupe, obligatoire: entree.obligatoire, options: entree.options });
      } else if (!codesPresents.has(entree.code)) {
        manquants.push({ code: entree.code, libelle: entree.libelle, obligatoire: entree.obligatoire });
      }
    }

    const historiqueResult = await db.query(
      `SELECT h.type_evenement, h.statut_avant, h.statut_apres, h.date_evenement, h.detail, u.nom AS agent_nom
       FROM demande_equivalence_historique h
       LEFT JOIN utilisateur u ON u.id = h.agent_id
       WHERE h.demande_equivalence_id = $1
       ORDER BY h.date_evenement ASC`,
      [id]
    );

    return res.status(200).json({
      success: true,
      demande,
      documents: documentsResult.rows,
      documents_manquants: manquants,
      historique: historiqueResult.rows,
    });
  } catch (error) {
    console.error('Erreur getDemandeById:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ── GET /api/equivalence/:id/documents/:documentId [admin|scolarite] ───────────────────────
// Indirection authentifiée : voir document de conception §7 pour la limite honnête de cette
// protection (le fichier local reste physiquement sous /uploads, servi statiquement comme le
// reste de l'application — cet endpoint ne fait qu'exiger d'être authentifié ET de connaître
// le couple (id demande, id document) avant d'obtenir l'URL réelle).
exports.getDocumentFile = async (req, res) => {
  try {
    const { id, documentId } = req.params;
    const result = await db.query(
      `SELECT fichier_path, storage_provider FROM document_equivalence
       WHERE id = $1 AND demande_equivalence_id = $2`,
      [documentId, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Document introuvable.' });
    }
    return res.status(200).json({ success: true, url: result.rows[0].fichier_path, provider: result.rows[0].storage_provider });
  } catch (error) {
    console.error('Erreur getDocumentFile:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ── PUT /api/equivalence/:id/documents/:documentId/statut [admin|scolarite] ────────────────
exports.marquerStatutDocument = async (req, res) => {
  try {
    const { id, documentId } = req.params;
    const { statut, commentaire } = req.body;
    if (!['conforme', 'illisible'].includes(statut)) {
      return res.status(400).json({ success: false, message: 'Statut invalide (conforme ou illisible attendu).' });
    }

    const result = await db.query(
      `UPDATE document_equivalence SET statut_document = $1, commentaire_verification = $2
       WHERE id = $3 AND demande_equivalence_id = $4
       RETURNING id, type_document_id`,
      [statut, commentaire || null, documentId, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Document introuvable.' });
    }

    await enregistrerEvenementHistorique(db, {
      demandeId: id,
      type: 'document_verifie',
      agentId: req.user?.id || null,
      detail: `Pièce marquée "${statut}"${commentaire ? ' — ' + commentaire : ''}.`,
    });

    return res.status(200).json({ success: true, message: 'Statut du document mis à jour.' });
  } catch (error) {
    console.error('Erreur marquerStatutDocument:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Phase 3 — Décision (prendre en charge, demander un complément, valider, refuser, annuler)
// ═══════════════════════════════════════════════════════════════════════════════════════════

// ── PUT /api/equivalence/:id/prendre-en-charge [admin|scolarite] ───────────────────────────
exports.prendreEnCharge = async (req, res) => {
  try {
    const { id } = req.params;
    const current = await db.query(`SELECT statut FROM demande_equivalence WHERE id = $1`, [id]);
    if (current.rows.length === 0) return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    if (current.rows[0].statut !== 'en_attente') {
      return res.status(409).json({ success: false, message: "Cette demande n'est pas en attente de prise en charge." });
    }

    await db.query(
      `UPDATE demande_equivalence SET statut = 'en_etude', traite_par = $1, date_prise_en_charge = NOW() WHERE id = $2`,
      [req.user.id, id]
    );
    await enregistrerEvenementHistorique(db, {
      demandeId: id, type: 'prise_en_charge', agentId: req.user.id, statutAvant: 'en_attente', statutApres: 'en_etude',
    });

    return res.status(200).json({ success: true, message: 'Demande prise en charge.' });
  } catch (error) {
    console.error('Erreur prendreEnCharge:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ── PUT /api/equivalence/:id/demander-complement [admin|scolarite] ─────────────────────────
exports.demanderComplement = async (req, res) => {
  try {
    const { id } = req.params;
    const { motif_complement } = req.body;
    if (!motif_complement || !motif_complement.trim()) {
      return res.status(400).json({ success: false, message: 'Le motif du complément est requis.' });
    }

    const current = await db.query(`SELECT statut, nom, prenoms, email, code_suivi FROM demande_equivalence WHERE id = $1`, [id]);
    if (current.rows.length === 0) return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    const demande = current.rows[0];
    if (!['en_attente', 'en_etude'].includes(demande.statut)) {
      return res.status(409).json({ success: false, message: "Cette demande ne peut pas recevoir de demande de complément dans son statut actuel." });
    }

    await db.query(
      `UPDATE demande_equivalence SET statut = 'dossier_incomplet', motif_complement = $1, traite_par = $2 WHERE id = $3`,
      [motif_complement.trim(), req.user.id, id]
    );
    await enregistrerEvenementHistorique(db, {
      demandeId: id, type: 'demande_complement', agentId: req.user.id,
      statutAvant: demande.statut, statutApres: 'dossier_incomplet', detail: motif_complement.trim(),
    });

    const template = emailService.templateDemandeComplement({
      prenoms: demande.prenoms, nom: demande.nom, codeSuivi: demande.code_suivi, motif: motif_complement.trim(),
    });
    const envoi = await emailService.envoyerEmail({ to: demande.email, ...template });
    await enregistrerEvenementHistorique(db, {
      demandeId: id, type: envoi.success ? 'mail_envoye' : 'mail_echec',
      detail: envoi.success ? 'Email pièces complémentaires envoyé.' : envoi.error,
    });

    return res.status(200).json({ success: true, message: 'Demande de complément envoyée au candidat.' });
  } catch (error) {
    console.error('Erreur demanderComplement:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ── PUT /api/equivalence/:id/valider [admin|scolarite, réservé à traite_par] ───────────────
// Voir document de conception §5.4 pour le détail exact de ce qui est transactionnel ici et
// pourquoi (fiche et e-mail restent volontairement hors transaction).
exports.validerDemande = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const demandeResult = await client.query(`SELECT * FROM demande_equivalence WHERE id = $1`, [id]);
    if (demandeResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    }
    const demande = demandeResult.rows[0];
    if (demande.statut !== 'en_etude') {
      return res.status(409).json({ success: false, message: "Cette demande doit être en cours d'étude pour être validée." });
    }
    if (String(demande.traite_par) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Seul l'agent en charge de ce dossier peut le valider." });
    }

    await client.query('BEGIN');

    // 1) Moteur de résolution formation+tarif+parcours réutilisé tel quel (même source que
    //    l'admission web/agent) — statutScolaire toujours 'Non affecté' : la notion
    //    "Affecté par le Ministère" ne concerne que les nouveaux bacheliers, jamais un
    //    candidat équivalence.
    const resolution = await resoudreFormationEtParcours(client, {
      niveauId: demande.niveau_id,
      filiereId: demande.id_filiere,
      curcusId: demande.curcus_id,
      statutScolaire: 'Non affecté',
    });
    if (resolution.erreur) {
      await client.query('ROLLBACK');
      return res.status(resolution.erreur.status).json({
        success: false, message: resolution.erreur.message, code: resolution.erreur.code,
      });
    }
    const tarif = resolution.tarif;

    // 2) Génération du code de paiement — colonne de la ligne etudiant elle-même : impossible
    //    structurellement qu'un étudiant existe sans code (document de conception §5.4).
    const cleanName = (str) => str.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '.').toLowerCase();
    const emailInstitutionnel = `${cleanName(demande.prenoms.split(' ')[0])}.${cleanName(demande.nom)}@iipea.com`;
    const codeUnique = await generateCodeUnique(demande.nom, demande.prenoms, demande.date_naissance);
    const matriculeIipea = await generateMatriculeIIPEA(demande.annee_academique_id, demande.id_filiere);
    const bcrypt = require('bcrypt');
    const hashedPassword = await bcrypt.hash('@elites@', 10);

    const etudiantResult = await avecRetryCodeUnique('EQ', async (codePaiement) => {
      return client.query(
        `INSERT INTO etudiant (
           matricule, nom, prenoms, date_naissance, lieu_naissance, telephone, email, email_personnel,
           lieu_residence, contact_parent, nom_parent_1, nom_parent_2, code_unique,
           etablissement_origine, inscrit_par, site_id, annee_academique_id, niveau_id,
           statut_scolaire, nationalite, standing, sexe, password, curcus_id, id_filiere,
           date_inscription, contact_etudiant, contact_parent_2, matricule_iipea,
           adresse_parent_1, adresse_parent_2, engagement_accepte, code_paiement,
           source_inscription, valide_scolarite
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW(),$26,$27,$28,$29,$30,$31,$32,'web',false)
         RETURNING id, code_paiement`,
        [
          demande.code_suivi, demande.nom, demande.prenoms, demande.date_naissance, demande.lieu_naissance,
          demande.telephone, emailInstitutionnel, demande.email,
          demande.adresse, demande.contact_parent, demande.nom_parent_1, demande.nom_parent_2, codeUnique,
          demande.etablissement_origine, demande.traite_par, demande.site_id, demande.annee_academique_id, demande.niveau_id,
          tarif.statut_applique, demande.nationalite, 'en attente', demande.sexe, hashedPassword, demande.curcus_id, demande.id_filiere,
          demande.telephone, demande.contact_parent_2, matriculeIipea,
          demande.adresse_parent_1, demande.adresse_parent_2, demande.engagement_accepte, codePaiement,
        ]
      );
    });
    const etudiantId = etudiantResult.rows[0].id;

    // 3) Scolarité
    const scolariteResult = await client.query(
      `INSERT INTO scolarite (montant_scolarite, scolarite_verse, statut_etudiant) VALUES ($1, 0, 'en attente') RETURNING id`,
      [tarif.montant]
    );
    await client.query(`UPDATE etudiant SET scolarite_id = $1 WHERE id = $2`, [scolariteResult.rows[0].id, etudiantId]);

    // 4) Copie des pièces équivalence (version courante uniquement) vers document_etudiant —
    //    fourni=true, declare_par_etudiant=true (réellement uploadées, contrairement à
    //    l'admission web où le candidat ne fait que déclarer).
    const docsEquivalence = await client.query(
      `SELECT DISTINCT ON (type_document_id) type_document_id, fichier_path, storage_provider, drive_file_id, drive_folder_id
       FROM document_equivalence WHERE demande_equivalence_id = $1
       ORDER BY type_document_id, date_upload DESC`,
      [id]
    );
    for (const doc of docsEquivalence.rows) {
      await client.query(
        `INSERT INTO document_etudiant (etudiant_id, type_document_id, fourni, declare_par_etudiant, fichier_path, storage_provider, drive_file_id, drive_folder_id, date_upload)
         VALUES ($1,$2,true,true,$3,$4,$5,$6,NOW())`,
        [etudiantId, doc.type_document_id, doc.fichier_path, doc.storage_provider, doc.drive_file_id, doc.drive_folder_id]
      );
    }
    // Complète les documents admission-only sans équivalent équivalence (photo, fiche
    // d'orientation, pièce d'identité du parent) — fourni=false, pour que l'écran de
    // Vérification affiche un dossier complet sans lignes redondantes avec les pièces
    // équivalence déjà copiées ci-dessus.
    const stubsAdmission = await client.query(
      `SELECT id FROM type_document WHERE contexte = 'admission' AND code IN ('PHOTO', 'FICHE_ORIENTATION', 'PIECE_IDENTITE_PARENT')`
    );
    for (const stub of stubsAdmission.rows) {
      await client.query(
        `INSERT INTO document_etudiant (etudiant_id, type_document_id, fourni, declare_par_etudiant) VALUES ($1, $2, false, false)`,
        [etudiantId, stub.id]
      );
    }

    await client.query(
      `UPDATE demande_equivalence SET statut = 'valide', etudiant_id = $1, date_traitement = NOW() WHERE id = $2`,
      [etudiantId, id]
    );
    await enregistrerEvenementHistorique(client, {
      demandeId: id, type: 'validation', agentId: req.user.id, statutAvant: 'en_etude', statutApres: 'valide',
    });
    await enregistrerEvenementHistorique(client, {
      demandeId: id, type: 'dossier_candidat_cree', agentId: req.user.id,
      detail: `Étudiant #${etudiantId}, matricule IIPEA ${matriculeIipea}, code de paiement ${etudiantResult.rows[0]?.code_paiement || ''}.`,
    });

    await client.query('COMMIT');

    // Hors transaction — voir §5.4/§8 : la fiche est un rendu à la demande (rien à perdre en
    // cas d'échec), l'e-mail est best-effort et son échec est journalisé, jamais bloquant.
    const ficheUrl = `${API_URL}/api/public/public/admission/${etudiantId}/fiche`;
    await enregistrerEvenementHistorique(db, { demandeId: id, type: 'fiche_generee', detail: `Disponible publiquement via ${ficheUrl}.` });

    const template = emailService.templateValidation({
      prenoms: demande.prenoms, nom: demande.nom, matriculeIipea,
      codePaiement: etudiantResult.rows[0].code_paiement, ficheUrl,
    });
    const envoi = await emailService.envoyerEmail({ to: demande.email, ...template });
    await enregistrerEvenementHistorique(db, {
      demandeId: id, type: envoi.success ? 'mail_envoye' : 'mail_echec',
      detail: envoi.success ? 'Email de validation envoyé.' : envoi.error,
    });

    return res.status(200).json({
      success: true,
      message: 'Demande validée, dossier candidat créé.',
      data: { etudiant_id: etudiantId, matricule_iipea: matriculeIipea },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur validerDemande:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.', details: error.message });
  } finally {
    client.release();
  }
};

// ── PUT /api/equivalence/:id/rejeter [admin|scolarite, réservé à traite_par] ───────────────
exports.rejeterDemande = async (req, res) => {
  try {
    const { id } = req.params;
    const { motif_refus } = req.body;
    if (!motif_refus || !motif_refus.trim()) {
      return res.status(400).json({ success: false, message: 'Le motif du refus est requis.' });
    }

    const current = await db.query(`SELECT statut, traite_par, nom, prenoms, email FROM demande_equivalence WHERE id = $1`, [id]);
    if (current.rows.length === 0) return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    const demande = current.rows[0];
    if (demande.statut !== 'en_etude') {
      return res.status(409).json({ success: false, message: "Cette demande doit être en cours d'étude pour être refusée." });
    }
    if (String(demande.traite_par) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "Seul l'agent en charge de ce dossier peut le refuser." });
    }

    await db.query(
      `UPDATE demande_equivalence SET statut = 'refuse', motif_refus = $1, date_traitement = NOW() WHERE id = $2`,
      [motif_refus.trim(), id]
    );
    await enregistrerEvenementHistorique(db, {
      demandeId: id, type: 'refus', agentId: req.user.id, statutAvant: 'en_etude', statutApres: 'refuse', detail: motif_refus.trim(),
    });

    const template = emailService.templateRefus({ prenoms: demande.prenoms, nom: demande.nom });
    const envoi = await emailService.envoyerEmail({ to: demande.email, ...template });
    await enregistrerEvenementHistorique(db, {
      demandeId: id, type: envoi.success ? 'mail_envoye' : 'mail_echec',
      detail: envoi.success ? 'Email de refus envoyé.' : envoi.error,
    });

    return res.status(200).json({ success: true, message: 'Demande refusée.' });
  } catch (error) {
    console.error('Erreur rejeterDemande:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ── PUT /api/equivalence/:id/annuler [admin|scolarite — PAS réservé à traite_par] ──────────
exports.annulerDemande = async (req, res) => {
  try {
    const { id } = req.params;
    const { motif_annulation } = req.body;
    if (!motif_annulation || !motif_annulation.trim()) {
      return res.status(400).json({ success: false, message: "Le motif de l'annulation est requis." });
    }

    const current = await db.query(`SELECT statut FROM demande_equivalence WHERE id = $1`, [id]);
    if (current.rows.length === 0) return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    const statutActuel = current.rows[0].statut;
    if (!['en_attente', 'dossier_incomplet', 'en_etude'].includes(statutActuel)) {
      return res.status(409).json({ success: false, message: 'Seule une demande non terminale peut être annulée.' });
    }

    await db.query(
      `UPDATE demande_equivalence SET statut = 'annule', motif_annulation = $1, date_traitement = NOW() WHERE id = $2`,
      [motif_annulation.trim(), id]
    );
    await enregistrerEvenementHistorique(db, {
      demandeId: id, type: 'annulation', agentId: req.user.id, statutAvant: statutActuel, statutApres: 'annule', detail: motif_annulation.trim(),
    });

    return res.status(200).json({ success: true, message: 'Demande annulée.' });
  } catch (error) {
    console.error('Erreur annulerDemande:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

// ── POST /api/equivalence/:id/renvoyer-email [admin|scolarite] ─────────────────────────────
exports.renvoyerEmail = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT de.statut, de.nom, de.prenoms, de.email, de.code_suivi, de.motif_complement, de.etudiant_id,
              e.matricule_iipea, e.code_paiement
       FROM demande_equivalence de
       LEFT JOIN etudiant e ON e.id = de.etudiant_id
       WHERE de.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    const demande = result.rows[0];

    let template;
    if (demande.statut === 'valide') {
      template = emailService.templateValidation({
        prenoms: demande.prenoms, nom: demande.nom, matriculeIipea: demande.matricule_iipea, codePaiement: demande.code_paiement,
        ficheUrl: `${API_URL}/api/public/public/admission/${demande.etudiant_id}/fiche`,
      });
    } else if (demande.statut === 'refuse') {
      template = emailService.templateRefus({ prenoms: demande.prenoms, nom: demande.nom });
    } else if (demande.statut === 'dossier_incomplet') {
      template = emailService.templateDemandeComplement({
        prenoms: demande.prenoms, nom: demande.nom, codeSuivi: demande.code_suivi, motif: demande.motif_complement,
      });
    } else {
      return res.status(400).json({ success: false, message: "Aucun e-mail pertinent à renvoyer pour le statut actuel de cette demande." });
    }

    const envoi = await emailService.envoyerEmail({ to: demande.email, ...template });
    await enregistrerEvenementHistorique(db, {
      demandeId: id, agentId: req.user.id, type: envoi.success ? 'mail_envoye' : 'mail_echec',
      detail: (envoi.success ? 'Email renvoyé manuellement.' : envoi.error) + ` (statut: ${demande.statut})`,
    });

    if (!envoi.success) {
      return res.status(502).json({ success: false, message: "Échec de l'envoi de l'e-mail.", error: envoi.error });
    }
    return res.status(200).json({ success: true, message: 'E-mail renvoyé.' });
  } catch (error) {
    console.error('Erreur renvoyerEmail:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
  }
};

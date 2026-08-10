const db = require('../config/db.config');
const fs = require('fs');
const moment = require('moment');
const { requiertChoixParcours, resoudreFormationEtParcours } = require('../services/parcoursProfessionnel.service');
const { validatePhotoFile } = require('./etudiant.controller');
const { traiterDemandeReinscription, IDENTITE_FIELDS: REINSCRIPTION_IDENTITE_FIELDS, chargerPiecesReinscription } = require('./reinscription.controller');
const { validerReferentielsIdentite } = require('../services/referentielIdentite.service');
const { getEcoleScopeFromUser } = require('../services/ecoleScope.service');

// Champs d'identité éditables lors de la vérification — mêmes règles obligatoires que addEtudiant
// (nom, prenoms, date_naissance, sexe, nationalite, telephone, email_personnel, contact_parent).
// matricule, annee_academique_id, site_id, code_paiement, code_unique, matricule_iipea, password,
// email, engagement_accepte, standing, source_inscription ne sont JAMAIS modifiés ici.
const REQUIRED_IDENTITE = ['nom', 'prenoms', 'date_naissance', 'sexe', 'nationalite', 'telephone', 'email_personnel', 'contact_parent'];
const OPTIONAL_IDENTITE = [
  'lieu_naissance', 'pays_naissance', 'lieu_residence', 'contact_parent_2',
  'nom_parent_1', 'nom_parent_2', 'adresse_parent_1', 'adresse_parent_2',
  'numero_acte_naissance', 'numero_piece_identite', 'annee_bac', 'serie_bac',
  'etablissement_origine', 'numero_table', 'mention_bac', 'ip_ministere'
];

// ─── GET recherche des dossiers Web à vérifier ──────────────────────────────
exports.rechercherDossierVerification = async (req, res) => {
  try {
    const { q, statut } = req.query;
    const siteId = req.user?.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }
    if (!siteId) {
      return res.status(400).json({ success: false, message: 'Site non identifié pour votre compte.' });
    }

    let statutFiltre = 'AND (e.valide_scolarite = false OR e.valide_scolarite IS NULL)';
    if (statut === 'verifies') {
      statutFiltre = 'AND e.valide_scolarite = true';
    } else if (statut === 'tous') {
      statutFiltre = '';
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (e.site_id) existant.
    const ecoleCond = ecoleId !== null ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)' : '';
    const params = ecoleId !== null ? [siteId, `%${q.trim()}%`, ecoleId] : [siteId, `%${q.trim()}%`];

    const result = await db.query(
      `SELECT e.id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url, e.valide_scolarite,
              f.nom AS filiere, n.libelle AS niveau
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       WHERE e.site_id = $1
         AND e.source_inscription = 'web'
         AND e.standing != 'Inscrit'
         ${statutFiltre}
         AND (
           e.nom ILIKE $2 OR e.prenoms ILIKE $2 OR e.matricule_iipea ILIKE $2
           OR (e.nom || ' ' || e.prenoms) ILIKE $2
           OR (e.prenoms || ' ' || e.nom) ILIKE $2
         )
         ${ecoleCond}
       ORDER BY e.nom, e.prenoms
       LIMIT 20`,
      params
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur rechercherDossierVerification:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET dossier complet d'un candidat Web ──────────────────────────────────
exports.getDossierVerification = async (req, res) => {
  try {
    const { id } = req.params;

    const etudiantResult = await db.query(
      `SELECT e.id, e.matricule, e.matricule_iipea, e.nom, e.prenoms, e.date_naissance, e.lieu_naissance,
              e.pays_naissance, e.sexe, e.nationalite, e.telephone, e.email_personnel, e.lieu_residence,
              e.contact_parent, e.contact_parent_2, e.nom_parent_1, e.nom_parent_2,
              e.adresse_parent_1, e.adresse_parent_2, e.numero_acte_naissance, e.numero_piece_identite,
              e.numero_table, e.annee_bac, e.serie_bac, e.mention_bac, e.etablissement_origine,
              e.statut_scolaire, e.ip_ministere, e.photo_url, e.code_paiement, e.source_inscription,
              e.standing, e.valide_scolarite, e.verifie_par, e.date_verification, e.observation_verification,
              e.niveau_id, e.id_filiere, e.site_id, e.annee_academique_id, e.curcus_id, e.scolarite_id,
              n.libelle AS niveau_libelle, f.nom AS filiere_nom, f.departement_id,
              tf.libelle AS type_filiere_libelle,
              d.nom AS departement_nom, d.ecole_id, ec.nom AS ecole_nom, s.nom AS site_nom,
              c.type_parcours AS parcours_actuel,
              sc.montant_scolarite
       FROM etudiant e
       JOIN filiere f ON f.id = e.id_filiere
       JOIN niveau n ON n.id = e.niveau_id
       LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
       LEFT JOIN departement d ON d.id = f.departement_id
       LEFT JOIN ecole ec ON ec.id = d.ecole_id
       JOIN site s ON s.id = e.site_id
       LEFT JOIN curcus c ON c.id = e.curcus_id
       LEFT JOIN scolarite sc ON sc.id = e.scolarite_id
       WHERE e.id = $1`,
      [id]
    );

    if (etudiantResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];

    if (etudiant.source_inscription !== 'web') {
      return res.status(400).json({
        success: false,
        code: 'HORS_PERIMETRE',
        message: "Ce dossier n'est pas une admission Web et ne relève pas de la vérification scolarité."
      });
    }

    const parcoursRequis = requiertChoixParcours(etudiant.type_filiere_libelle, etudiant.niveau_libelle);
    const parcoursResult = await db.query(
      `SELECT id, type_parcours FROM curcus WHERE type_parcours != 'Universitaire' ORDER BY type_parcours`
    );

    // Documents admission : toujours affichés (LEFT JOIN, comme avant). Documents équivalence
    // (contexte='equivalence', codes préfixés EQ_) : affichés UNIQUEMENT si ce candidat en a
    // réellement une ligne document_etudiant — copiée à la validation pour son niveau précis
    // (equivalence.controller.js::validerDemande). Sans cette restriction, les 14 documents
    // équivalence possibles (tous niveaux confondus) s'afficheraient pour chaque dossier,
    // y compris les pièces d'un tout autre niveau que le sien.
    const documentsResult = await db.query(
      `SELECT td.code, td.libelle, td.obligatoire, de.fourni, de.declare_par_etudiant, de.fichier_path
       FROM type_document td
       LEFT JOIN document_etudiant de ON de.type_document_id = td.id AND de.etudiant_id = $1
       WHERE (td.contexte = 'admission' AND td.code != 'PHOTO')
          OR (td.contexte = 'equivalence' AND de.id IS NOT NULL)
       ORDER BY td.id`,
      [id]
    );

    res.status(200).json({
      success: true,
      data: {
        etudiant,
        hierarchie: {
          ecole: etudiant.ecole_nom,
          departement: etudiant.departement_nom,
          filiere: etudiant.filiere_nom,
          niveau: etudiant.niveau_libelle,
          site: etudiant.site_nom
        },
        parcours_requis: parcoursRequis,
        parcours_options: parcoursResult.rows,
        documents: documentsResult.rows
      }
    });
  } catch (error) {
    console.error('Erreur getDossierVerification:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST confirmer un dossier Web pour paiement ────────────────────────────
// 1) Valide l'identité (mêmes champs obligatoires que addEtudiant).
// 2) Si filière/niveau/parcours changent, ré-résout l'intégralité du triplet + tarif via
//    resoudreFormationEtParcours (jamais un correctif de champ isolé) — bloque avant écriture
//    si la nouvelle combinaison exige un parcours non fourni.
// 3) Applique les cases "fourni" par document, sans jamais toucher declare_par_etudiant.
// 4) Traite la photo (remplace uniquement photo_url).
// 5) Lève valide_scolarite, sans jamais régénérer code_paiement.
exports.confirmerVerification = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const identite = req.body.identite || {};
    const formation = req.body.formation || {};
    const fourni = req.body.fourni || {};
    const observationVerification = req.body.observation_verification;

    await client.query('BEGIN');

    const etudiantResult = await client.query(
      `SELECT id, niveau_id, id_filiere, curcus_id, statut_scolaire, scolarite_id, source_inscription, standing, photo_url,
              sexe, nationalite, pays_naissance, serie_bac, etablissement_origine
       FROM etudiant WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (etudiantResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Étudiant introuvable.' });
    }
    const etudiant = etudiantResult.rows[0];

    if (etudiant.source_inscription !== 'web') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        code: 'HORS_PERIMETRE',
        message: "Ce dossier n'est pas une admission Web et ne relève pas de la vérification scolarité."
      });
    }
    if (etudiant.standing === 'Inscrit') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        code: 'DEJA_PAYE',
        message: 'Ce dossier a déjà été payé et finalisé ; la formation ne peut plus être modifiée ici.'
      });
    }

    const missing = REQUIRED_IDENTITE.filter(f => !identite[f]);
    if (missing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Champs obligatoires manquants.', message: 'Champs obligatoires manquants.', missingFields: missing, code: 'MISSING_FIELDS' });
    }

    const champsInvalides = await validerReferentielsIdentite(identite, etudiant);
    if (champsInvalides.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        code: 'REFERENTIEL_INVALIDE',
        message: `Valeur(s) invalide(s) pour : ${champsInvalides.join(', ')}.`
      });
    }

    // ── Étape 2 : ré-résolution atomique si filière/niveau/parcours a changé ──
    const nouveauNiveauId = formation.niveau_id ? parseInt(formation.niveau_id, 10) : etudiant.niveau_id;
    const nouvelleFiliereId = formation.id_filiere ? parseInt(formation.id_filiere, 10) : etudiant.id_filiere;
    const nouveauCurcusId = formation.curcus_id !== undefined && formation.curcus_id !== null && formation.curcus_id !== ''
      ? parseInt(formation.curcus_id, 10)
      : null;
    const ancienCurcusId = etudiant.curcus_id ?? null;

    const formationModifiee = (
      nouveauNiveauId !== etudiant.niveau_id ||
      nouvelleFiliereId !== etudiant.id_filiere ||
      nouveauCurcusId !== ancienCurcusId
    );

    let montantScolarite = null;
    let statutScolaireResolu = etudiant.statut_scolaire;
    let curcusIdFinal = etudiant.curcus_id;
    let niveauIdFinal = etudiant.niveau_id;
    let filiereIdFinal = etudiant.id_filiere;

    if (formationModifiee) {
      const resolution = await resoudreFormationEtParcours(client, {
        niveauId: nouveauNiveauId,
        filiereId: nouvelleFiliereId,
        curcusId: nouveauCurcusId,
        statutScolaire: etudiant.statut_scolaire
      });
      if (resolution.erreur) {
        await client.query('ROLLBACK');
        return res.status(resolution.erreur.status).json({
          success: false,
          message: resolution.erreur.message,
          code: resolution.erreur.code
        });
      }
      montantScolarite = resolution.tarif.montant;
      statutScolaireResolu = resolution.tarif.statut_applique;
      curcusIdFinal = nouveauCurcusId;
      niveauIdFinal = nouveauNiveauId;
      filiereIdFinal = nouvelleFiliereId;
    }

    // ── Étape 3 : cases "fourni" par document, jamais declare_par_etudiant ──
    // Même principe de restriction que le SELECT d'affichage (ligne ~130) : les documents
    // équivalence ne sont proposés que si ce candidat en a réellement une ligne.
    const typeDocResult = await client.query(
      `SELECT td.id, td.code FROM type_document td
       WHERE (td.contexte = 'admission' AND td.code != 'PHOTO')
          OR (td.contexte = 'equivalence' AND EXISTS (
                SELECT 1 FROM document_etudiant de WHERE de.etudiant_id = $1 AND de.type_document_id = td.id
              ))`,
      [id]
    );
    for (const typeDoc of typeDocResult.rows) {
      if (!(typeDoc.code in fourni)) continue;
      const valeur = fourni[typeDoc.code] === true || fourni[typeDoc.code] === 'true';
      await client.query(
        `UPDATE document_etudiant SET fourni = $1 WHERE etudiant_id = $2 AND type_document_id = $3`,
        [valeur, id, typeDoc.id]
      );
    }

    // ── Étape 4 : photo (remplace uniquement photo_url) ──
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    const photoFile = uploadedFiles.find(f => f.fieldname === 'photo');
    let photoUrl = etudiant.photo_url;
    if (photoFile) {
      const validation = validatePhotoFile(photoFile);
      if (!validation.valid) {
        if (photoFile.path && fs.existsSync(photoFile.path)) fs.unlinkSync(photoFile.path);
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: validation.error, message: validation.error, code: 'INVALID_PHOTO' });
      }
      photoUrl = `/uploads/photos/${photoFile.filename}`;
    }

    // ── Étape 5 : écriture finale — code_paiement jamais touché ──
    await client.query(
      `UPDATE etudiant SET
         nom = $1, prenoms = $2, date_naissance = $3, sexe = $4, nationalite = $5, telephone = $6,
         email_personnel = $7, contact_parent = $8, lieu_naissance = $9, pays_naissance = $10,
         lieu_residence = $11, contact_parent_2 = $12, nom_parent_1 = $13, nom_parent_2 = $14,
         adresse_parent_1 = $15, adresse_parent_2 = $16, numero_acte_naissance = $17,
         numero_piece_identite = $18, annee_bac = $19, serie_bac = $20, etablissement_origine = $21,
         numero_table = $22, mention_bac = $23, ip_ministere = $24,
         niveau_id = $25, id_filiere = $26, curcus_id = $27, statut_scolaire = $28,
         photo_url = $29,
         valide_scolarite = true, verifie_par = $30, date_verification = now(),
         observation_verification = $31
       WHERE id = $32`,
      [
        identite.nom.toUpperCase(), identite.prenoms.toUpperCase(),
        moment(identite.date_naissance).format('YYYY-MM-DD'),
        identite.sexe, identite.nationalite, identite.telephone, identite.email_personnel,
        identite.contact_parent,
        identite.lieu_naissance || null, identite.pays_naissance || null, identite.lieu_residence || null,
        identite.contact_parent_2 || null, identite.nom_parent_1 || null, identite.nom_parent_2 || null,
        identite.adresse_parent_1 || null, identite.adresse_parent_2 || null,
        identite.numero_acte_naissance || null, identite.numero_piece_identite || null,
        identite.annee_bac || null, identite.serie_bac || null, identite.etablissement_origine || null,
        identite.numero_table || null, identite.mention_bac || null, identite.ip_ministere || null,
        niveauIdFinal, filiereIdFinal, curcusIdFinal, statutScolaireResolu,
        photoUrl,
        req.user.id, observationVerification || null,
        id
      ]
    );

    if (formationModifiee && etudiant.scolarite_id) {
      await client.query(`UPDATE scolarite SET montant_scolarite = $1 WHERE id = $2`, [montantScolarite, etudiant.scolarite_id]);
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Dossier vérifié : le paiement est désormais autorisé.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur confirmerVerification:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

// ══════════════════════════════════════════════════════════════════════════
// Vérification des réinscriptions Web — mêmes principes que ci-dessus, appliqués
// à la table `reinscription` (source_inscription='web') plutôt qu'à `etudiant`.
// ══════════════════════════════════════════════════════════════════════════

// ─── GET recherche des dossiers de réinscription Web à vérifier ────────────
exports.rechercherReinscriptionVerification = async (req, res) => {
  try {
    const { q, statut } = req.query;
    const siteId = req.user?.departement_id;
    const ecoleId = getEcoleScopeFromUser(req);
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir au moins 2 caractères.' });
    }
    if (!siteId) {
      return res.status(400).json({ success: false, message: 'Site non identifié pour votre compte.' });
    }

    let statutFiltre = 'AND (r.valide_scolarite = false OR r.valide_scolarite IS NULL)';
    if (statut === 'verifies') {
      statutFiltre = 'AND r.valide_scolarite = true';
    } else if (statut === 'tous') {
      statutFiltre = '';
    }

    // Cloisonnement par école (Chantier 3) — cumulatif avec le filtre site (e.site_id) existant.
    const ecoleCond = ecoleId !== null ? 'AND f.departement_id IN (SELECT id FROM departement WHERE ecole_id = $3)' : '';
    const params = ecoleId !== null ? [siteId, `%${q.trim()}%`, ecoleId] : [siteId, `%${q.trim()}%`];

    const result = await db.query(
      `SELECT r.id AS reinscription_id, e.id AS etudiant_id, e.nom, e.prenoms, e.matricule_iipea, e.photo_url,
              r.valide_scolarite,
              f.nom AS filiere, n.libelle AS niveau
       FROM reinscription r
       JOIN etudiant e ON e.id = r.etudiant_id
       JOIN niveau n ON n.id = r.niveau_retenu_id
       LEFT JOIN filiere f ON f.id = COALESCE(r.id_filiere_retenu, e.id_filiere)
       WHERE e.site_id = $1
         AND r.source_inscription = 'web'
         AND r.statut != 'inscrit'
         ${statutFiltre}
         AND (
           e.nom ILIKE $2 OR e.prenoms ILIKE $2 OR e.matricule_iipea ILIKE $2
           OR (e.nom || ' ' || e.prenoms) ILIKE $2
           OR (e.prenoms || ' ' || e.nom) ILIKE $2
         )
         ${ecoleCond}
       ORDER BY e.nom, e.prenoms
       LIMIT 20`,
      params
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erreur rechercherReinscriptionVerification:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── GET dossier complet d'une réinscription Web ───────────────────────────
exports.getReinscriptionVerification = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT r.*,
              e.nom, e.prenoms, e.matricule_iipea, e.photo_url, e.telephone, e.email,
              e.lieu_residence, e.contact_parent, e.contact_parent_2, e.adresse_parent_1, e.adresse_parent_2,
              e.numero_acte_naissance, e.numero_piece_identite, e.mention_bac, e.annee_bac,
              e.sexe, e.nationalite, e.pays_naissance, e.serie_bac, e.etablissement_origine,
              e.statut_scolaire,
              e.site_id, e.id_filiere AS etudiant_id_filiere_actuel, e.niveau_id AS etudiant_niveau_id_actuel,
              n.libelle AS niveau_retenu_libelle, f.nom AS filiere_retenu_nom, f.departement_id,
              tf.libelle AS type_filiere_libelle,
              d.nom AS departement_nom, d.ecole_id, ec.nom AS ecole_nom,
              npre.libelle AS niveau_precedent_libelle,
              c.type_parcours AS parcours_actuel,
              s.nom AS site_nom
       FROM reinscription r
       JOIN etudiant e ON e.id = r.etudiant_id
       JOIN niveau n ON n.id = r.niveau_retenu_id
       LEFT JOIN filiere f ON f.id = COALESCE(r.id_filiere_retenu, e.id_filiere)
       LEFT JOIN typefiliere tf ON tf.id = f.type_filiere_id
       LEFT JOIN departement d ON d.id = f.departement_id
       LEFT JOIN ecole ec ON ec.id = d.ecole_id
       LEFT JOIN niveau npre ON npre.id = r.niveau_precedent_id
       LEFT JOIN curcus c ON c.id = r.curcus_id
       JOIN site s ON s.id = e.site_id
       WHERE r.id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Dossier de réinscription introuvable.' });
    }
    const dossier = result.rows[0];

    if (dossier.source_inscription !== 'web') {
      return res.status(400).json({
        success: false,
        code: 'HORS_PERIMETRE',
        message: "Ce dossier n'est pas une réinscription Web et ne relève pas de la vérification scolarité."
      });
    }

    const parcoursResult = await db.query(
      `SELECT id, type_parcours FROM curcus WHERE type_parcours != 'Universitaire' ORDER BY type_parcours`
    );

    const estBts2VersL3Pro = /^BTS\s*2$/i.test((dossier.niveau_precedent_libelle || '').trim())
      && /^LICENCE 3 PRO$/i.test((dossier.niveau_retenu_libelle || '').trim());

    // ✅ Pièces justificatives — unique source de vérité, cf. chargerPiecesReinscription
    // (reinscription.controller.js), également réutilisée par la création agent.
    const documents = await chargerPiecesReinscription(dossier.etudiant_id, estBts2VersL3Pro);

    res.status(200).json({
      success: true,
      data: { dossier, parcours_options: parcoursResult.rows, est_bts2_vers_l3pro: estBts2VersL3Pro, documents }
    });
  } catch (error) {
    console.error('Erreur getReinscriptionVerification:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  }
};

// ─── POST confirmer un dossier de réinscription Web pour paiement ─────────
// N'est jamais une nouvelle demande : contrôle, corrige, valide le dossier EXISTANT — aucun
// nouveau dossier, aucun nouveau code RI, aucun historique dupliqué (mode='verification' de
// traiterDemandeReinscription, garanti par cette fonction elle-même).
exports.confirmerReinscriptionVerification = async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;
    const identite = req.body.identite || {};
    const formation = req.body.formation || {};
    const fourni = req.body.fourni || {};
    const observationVerification = req.body.observation_verification;
    const statutScolaireCorrige = req.body.statut_scolaire || null;

    const dossierResult = await client.query('SELECT * FROM reinscription WHERE id = $1', [id]);
    if (dossierResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Dossier de réinscription introuvable.' });
    }
    const dossier = dossierResult.rows[0];

    if (dossier.source_inscription !== 'web') {
      return res.status(400).json({
        success: false,
        code: 'HORS_PERIMETRE',
        message: "Ce dossier n'est pas une réinscription Web et ne relève pas de la vérification scolarité."
      });
    }
    if (dossier.statut === 'inscrit') {
      return res.status(409).json({
        success: false,
        code: 'DEJA_PAYE',
        message: 'Ce dossier a déjà été payé et finalisé ; il ne peut plus être modifié ici.'
      });
    }

    // Cas particulier BTS 2 → Licence 3 PRO : les pièces obligatoires (contexte='reinscription')
    // doivent être physiquement contrôlées par l'agent avant toute validation — jamais déclaré
    // par le portail Web (voir commentaire plus bas, upsert manuel).
    const niveauPrecedentResult = await client.query('SELECT libelle FROM niveau WHERE id = $1', [dossier.niveau_precedent_id]);
    const niveauRetenuResult = await client.query('SELECT libelle FROM niveau WHERE id = $1', [formation.niveau_retenu_id || dossier.niveau_retenu_id]);
    const estBts2VersL3Pro = /^BTS\s*2$/i.test((niveauPrecedentResult.rows[0]?.libelle || '').trim())
      && /^LICENCE 3 PRO$/i.test((niveauRetenuResult.rows[0]?.libelle || '').trim());
    if (estBts2VersL3Pro) {
      const documentsObligatoires = await client.query(
        `SELECT td.code, td.libelle, de.fourni
         FROM type_document td
         LEFT JOIN document_etudiant de ON de.type_document_id = td.id AND de.etudiant_id = $1
         WHERE td.contexte = 'reinscription' AND td.obligatoire = true`,
        [dossier.etudiant_id]
      );
      const manquants = documentsObligatoires.rows
        .filter(d => !(fourni[d.code] === true || fourni[d.code] === 'true' || d.fourni === true))
        .map(d => d.libelle);
      if (manquants.length > 0) {
        return res.status(400).json({
          success: false,
          code: 'PIECES_OBLIGATOIRES_MANQUANTES',
          message: `Pièce(s) obligatoire(s) non fournie(s) : ${manquants.join(', ')}.`
        });
      }
    }

    const identiteFields = Object.fromEntries(
      REINSCRIPTION_IDENTITE_FIELDS.map(f => [f, identite[f] || null])
    );

    // Photo — remplace uniquement photo_url, même principe que la vérification d'admission.
    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    const photoFile = uploadedFiles.find(f => f.fieldname === 'photo');
    let photoUrl = null;
    if (photoFile) {
      const validation = validatePhotoFile(photoFile);
      if (!validation.valid) {
        if (photoFile.path && fs.existsSync(photoFile.path)) fs.unlinkSync(photoFile.path);
        return res.status(400).json({ success: false, message: validation.error, code: 'INVALID_PHOTO' });
      }
      photoUrl = `/uploads/photos/${photoFile.filename}`;
    }

    const result = await traiterDemandeReinscription(client, {
      etudiantId: dossier.etudiant_id,
      niveauRetenuId: formation.niveau_retenu_id || dossier.niveau_retenu_id,
      idFiliereChoisie: formation.id_filiere || dossier.id_filiere_retenu,
      curcusId: (formation.curcus_id !== undefined && formation.curcus_id !== null && formation.curcus_id !== '')
        ? formation.curcus_id
        : dossier.curcus_id,
      nombreVersementsPrevu: dossier.nombre_versements_prevu,
      modalitePaiement: dossier.modalite_paiement,
      identiteFields,
      photoUrl,
      traitePar: null,
      sourceInscription: 'web',
      mode: 'verification'
    });

    if (result.erreur) {
      return res.status(result.erreur.status).json({
        success: false,
        ...(result.erreur.code ? { code: result.erreur.code } : {}),
        message: result.erreur.message
      });
    }

    // Contrôle physique par l'agent — jamais déclaré (le champ correspondant est
    // declare_par_etudiant, jamais modifié ici). Couvre désormais aussi bien les pièces générales
    // (contexte='admission', réutilisées telles quelles pour la réinscription) que les 2 pièces
    // spécifiques BTS 2 → Licence 3 PRO (contexte='reinscription'). Upsert manuel : aucune ligne
    // n'existe tant que l'agent n'a pas coché au moins une fois.
    for (const [code, valeur] of Object.entries(fourni)) {
      const typeDocResult = await client.query(
        `SELECT id FROM type_document WHERE code = $1 AND contexte IN ('admission', 'reinscription')`,
        [code]
      );
      if (typeDocResult.rows.length === 0) continue;
      const typeDocId = typeDocResult.rows[0].id;
      const estFourni = valeur === true || valeur === 'true';
      const updateResult = await client.query(
        `UPDATE document_etudiant SET fourni = $1 WHERE etudiant_id = $2 AND type_document_id = $3`,
        [estFourni, dossier.etudiant_id, typeDocId]
      );
      if (updateResult.rowCount === 0) {
        await client.query(
          `INSERT INTO document_etudiant (etudiant_id, type_document_id, fourni) VALUES ($1, $2, $3)`,
          [dossier.etudiant_id, typeDocId, estFourni]
        );
      }
    }

    // Statut scolaire — correction explicite optionnelle de l'agent (route déjà restreinte à
    // admin/scolarite via staffOnly). Appliquée APRÈS traiterDemandeReinscription pour ne jamais
    // interférer avec son calcul automatique de changementDeCycle lors d'une création normale —
    // ceci est une correction ponctuelle propre à cet écran de vérification, pas une règle
    // dupliquée dans le moteur partagé.
    if (statutScolaireCorrige) {
      await client.query(`UPDATE etudiant SET statut_scolaire = $1 WHERE id = $2`, [statutScolaireCorrige, dossier.etudiant_id]);
    }

    await client.query(
      `UPDATE reinscription SET valide_scolarite = true, verifie_par = $1, date_verification = now(), observation_verification = $2 WHERE id = $3`,
      [req.user.id, observationVerification || null, id]
    );

    res.status(200).json({ success: true, message: 'Dossier de réinscription vérifié : le paiement est désormais autorisé.' });
  } catch (error) {
    console.error('Erreur confirmerReinscriptionVerification:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};
